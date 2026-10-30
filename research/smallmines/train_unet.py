"""U-Net mining-state model for GhanaWatch, trained on SmallMinesDS labels.

Two sources of inputs share the SmallMinesDS masks and its official train/test split (by patch id):
  A  the SmallMinesDS patches themselves (2016 and 2022), channels built by features.py;
  B  GhanaWatch's own monthly composites at the same footprints (Dec 2021, Jan 2022, Feb 2022), channels
     built by the production code (src/pipeline/ts/cube-cli.ts), labelled with the January 2022 mask.
Training on both teaches the model the production inputs (B) and more variety (A, two years, other
compositing). Normalisation statistics come from B, the inputs the model will see in production.

The model is trained to cope with whatever a month offers: all Sentinel-2 bands, Landsat only (no red
edge), radar only (cloud), cloud holes inside a patch, and 20 m inputs (the cells outside the gold belt).

    python3 train_unet.py prep                 # caches under results/cache
    python3 train_unet.py train [epochs]       # results/unet.pt + unet_meta.json
    python3 train_unet.py eval                 # results/unet_eval.json (both sources, every regime)
    python3 train_unet.py calibrate            # per-regime logistic calibration on B training patches
    python3 train_unet.py export               # results/gw_mining_unet.onnx (+ .json), weights stored as float16
"""
from __future__ import annotations

import glob
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from data import index, load, block_of
from features import CHANNELS, N_CH, OPTICAL, RED_EDGE, RADAR, normalise

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results")
CACHE = os.path.join(OUT, "cache")
CUBE = os.environ.get("GW_CUBE", "/home/claude/data/cube")
CUBE_MONTHS = os.environ.get("GW_CUBE_MONTHS", "2021-12,2022-01,2022-02").split(",")
os.makedirs(CACHE, exist_ok=True)
ENCODER = os.environ.get("UNET_ENCODER", "resnet18")
torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "2")))
ci = {c: i for i, c in enumerate(CHANNELS)}


def _write(name, X, Y, meta):
    np.save(f"{CACHE}/{name}_x.npy", X); np.save(f"{CACHE}/{name}_y.npy", Y)
    json.dump(meta, open(f"{CACHE}/{name}_meta.json", "w"))
    print(name, X.shape, file=sys.stderr)


def prep(which="AB"):
    patches = index()
    masks22 = {}
    # A: SmallMinesDS tiles
    for split in (("train", "test") if "A" in which else ()):
        ps = [p for p in patches if p.split == split]
        X = np.lib.format.open_memmap(f"{CACHE}/A_{split}_x.npy", "w+", np.float16, (len(ps), N_CH, 128, 128))
        Y = np.zeros((len(ps), 128, 128), np.uint8)
        meta = []
        for i, p in enumerate(ps):
            x, m = load(p)
            X[i] = x.astype(np.float16); Y[i] = m
            if p.year == 2022: masks22[p.pid] = (m, split)
            meta.append({"pid": p.pid, "year": p.year, "block": block_of(p)})
        X.flush(); np.save(f"{CACHE}/A_{split}_y.npy", Y); json.dump(meta, open(f"{CACHE}/A_{split}_meta.json", "w"))
        print("A", split, len(ps), file=sys.stderr)
    if "B" not in which:
        return
    if not masks22:
        for p in patches:
            if p.year == 2022:
                _, m = load(p); masks22[p.pid] = (m, p.split)
    # B: GhanaWatch composites
    for split in ("train", "test"):
        items = []
        for month in CUBE_MONTHS:
            for pid, (m, sp) in masks22.items():
                f = f"{CUBE}/{month}/{pid}.npy"
                if sp == split and os.path.exists(f):
                    items.append((pid, month, f, m))
        X = np.lib.format.open_memmap(f"{CACHE}/B_{split}_x.npy", "w+", np.float16, (len(items), N_CH, 128, 128))
        Y = np.zeros((len(items), 128, 128), np.uint8)
        for i, (pid, month, f, m) in enumerate(items):
            X[i] = np.load(f); Y[i] = m
        X.flush(); np.save(f"{CACHE}/B_{split}_y.npy", Y)
        json.dump([{"pid": a, "month": b} for a, b, _, _ in items], open(f"{CACHE}/B_{split}_meta.json", "w"))
        print("B", split, len(items), file=sys.stderr)
    # Normalisation from B training patches (production inputs), observed values only.
    X = np.load(f"{CACHE}/B_train_x.npy", mmap_mode="r")
    sel = np.random.default_rng(0).choice(len(X), min(800, len(X)), replace=False)
    xs = np.asarray(X[np.sort(sel)], np.float32)
    mean = np.zeros(N_CH, np.float32); std = np.ones(N_CH, np.float32)
    for c in range(N_CH):
        if c in (ci["OPT_OK"], ci["RE_OK"]): continue
        v = xs[:, c]
        if c in OPTICAL: v = v[xs[:, ci["OPT_OK"]] > 0.5]
        if c in RED_EDGE: v = xs[:, c][xs[:, ci["RE_OK"]] > 0.5]
        if c in RADAR: v = v[v != 0]
        mean[c] = float(np.mean(v)); std[c] = float(np.std(v) + 1e-6)
    json.dump({"channels": CHANNELS, "mean": mean.tolist(), "std": std.tolist()}, open(f"{OUT}/norm.json", "w"), indent=1)


class DS(torch.utils.data.Dataset):
    def __init__(self, names, augment, regime=None):
        self.parts = [(np.load(f"{CACHE}/{n}_x.npy", mmap_mode="r"), np.load(f"{CACHE}/{n}_y.npy", mmap_mode="r")) for n in names]
        self.idx = [(k, i) for k, (X, _) in enumerate(self.parts) for i in range(len(X))]
        n = json.load(open(f"{OUT}/norm.json"))
        self.mean = np.array(n["mean"], np.float32); self.std = np.array(n["std"], np.float32)
        self.augment = augment
        self.regime = regime
        self.rng = np.random.default_rng()

    def __len__(self):
        return len(self.idx)

    def simulate(self, x, regime):
        """Hide channel groups the way a month can: landsat (no red edge, NIR from B8A), radar_only, cloud holes."""
        if regime == "landsat":
            x[ci["B08"]] = x[ci["B8A"]]
            nd = lambda a, b: (x[ci[a]] - x[ci[b]]) / (x[ci[a]] + x[ci[b]] + 1e-6)
            x[ci["NDVI"]] = nd("B8A", "B04"); x[ci["NDWI"]] = nd("B03", "B8A"); x[ci["NBR"]] = nd("B8A", "B12")
            x[ci["BSI"]] = ((x[ci["B11"]] + x[ci["B04"]]) - (x[ci["B8A"]] + x[ci["B02"]])) / ((x[ci["B11"]] + x[ci["B04"]]) + (x[ci["B8A"]] + x[ci["B02"]]) + 1e-6)
            x[ci["RE_OK"]] = 0
        elif regime == "radar_only":
            x[ci["OPT_OK"]] = 0; x[ci["RE_OK"]] = 0
        elif regime == "cloud":
            yy, xx = np.mgrid[0:128, 0:128]
            hole = np.zeros((128, 128), bool)
            for _ in range(self.rng.integers(1, 4)):
                cy, cx = self.rng.integers(0, 128, 2); ry, rx = self.rng.integers(10, 50, 2)
                hole |= ((yy - cy) / ry) ** 2 + ((xx - cx) / rx) ** 2 < 1
            x[ci["OPT_OK"]][hole] = 0; x[ci["RE_OK"]][hole] = 0
        return x

    def __getitem__(self, j):
        k, i = self.idx[j]
        X, Y = self.parts[k]
        x = np.asarray(X[i], np.float32).copy(); y = np.asarray(Y[i], np.float32).copy()
        regime = self.regime
        if self.augment:
            u = self.rng.random()
            regime = "landsat" if u < 0.15 else "radar_only" if u < 0.27 else "cloud" if u < 0.52 else None
        if regime:
            x = self.simulate(x, regime)
        x = normalise(x, self.mean, self.std)
        if self.augment:
            r = int(self.rng.integers(0, 4))
            x = np.rot90(x, r, (1, 2)); y = np.rot90(y, r)
            if self.rng.random() < 0.5:
                x = x[:, :, ::-1]; y = y[:, ::-1]
        return torch.from_numpy(np.ascontiguousarray(x)), torch.from_numpy(np.ascontiguousarray(y))[None]


def make_model(pretrained=True):
    import segmentation_models_pytorch as smp
    # A lighter decoder than the default (256..16): about 30% less compute at 128 px, for CPU training and inference.
    return smp.Unet(encoder_name=ENCODER, encoder_weights="imagenet" if pretrained else None, in_channels=N_CH, classes=1, decoder_channels=(128, 64, 32, 16, 16))


def dice_loss(logits, y):
    p = torch.sigmoid(logits)
    inter = (p * y).sum((1, 2, 3)); s = p.sum((1, 2, 3)) + y.sum((1, 2, 3))
    return (1 - (2 * inter + 1) / (s + 1)).mean()


def to20m(x, y):
    """Simulate a 20 m composite: 2 x 2 mean of the channels (flags kept as 'any observed'), mask by majority."""
    flags = x[:, [ci["OPT_OK"], ci["RE_OK"]]]
    x2 = F.avg_pool2d(x, 2)
    x2[:, [ci["OPT_OK"], ci["RE_OK"]]] = (F.avg_pool2d(flags, 2) > 0).float()
    return x2, (F.avg_pool2d(y, 2) >= 0.5).float()


def train(epochs=14, bs=16, per_epoch=2400):
    model = make_model(True).to(memory_format=torch.channels_last)
    ds = DS(["A_train", "B_train"], True)
    # B (production inputs) is drawn twice as often as A.
    nA = len(ds.parts[0][0]); nB = len(ds.parts[1][0])
    w = np.concatenate([np.full(nA, 1.0), np.full(nB, 2.0 * nA / max(nB, 1))]); w /= w.sum()
    sampler = torch.utils.data.WeightedRandomSampler(torch.from_numpy(w), num_samples=per_epoch, replacement=True)
    dl = torch.utils.data.DataLoader(ds, batch_size=bs, sampler=sampler, num_workers=1, drop_last=True, persistent_workers=True)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=epochs * len(dl), pct_start=0.1)
    pos_w = torch.tensor(3.0)
    rng = np.random.default_rng(1)
    t0 = time.time(); log = []
    start = 0
    ck = f"{OUT}/unet_ckpt.pt"
    if os.path.exists(ck):  # resume after an interruption, same schedule
        c = torch.load(ck, weights_only=False)
        if c.get("epochs") == epochs:
            model.load_state_dict(c["model"]); opt.load_state_dict(c["opt"]); sched.load_state_dict(c["sched"])
            start = c["epoch"]; log = c["log"]; t0 -= c["seconds"]
            print(f"resuming after epoch {start}", file=sys.stderr, flush=True)
    for ep in range(start, epochs):
        model.train(); tot = 0.0
        for x, y in dl:
            if rng.random() < 0.2:
                x, y = to20m(x, y)
            # bfloat16 on the CPU's matrix units (AMX) for speed; the loss is computed in float32.
            with torch.autocast("cpu", dtype=torch.bfloat16):
                logits = model(x.contiguous(memory_format=torch.channels_last))
            logits = logits.float()
            loss = F.binary_cross_entropy_with_logits(logits, y, pos_weight=pos_w) + dice_loss(logits, y)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            tot += float(loss)
        ev = evaluate(model, "B_test", None, limit=400)
        log.append({"epoch": ep + 1, "loss": tot / len(dl), "B_test_quick": ev, "minutes": round((time.time() - t0) / 60, 1)})
        print(json.dumps(log[-1]), file=sys.stderr, flush=True)
        torch.save(model.state_dict(), f"{OUT}/unet.pt")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "epoch": ep + 1, "epochs": epochs, "log": log, "seconds": time.time() - t0}, ck)
    json.dump({"encoder": ENCODER, "channels": CHANNELS, "epochs": epochs, "per_epoch": per_epoch, "log": log}, open(f"{OUT}/unet_meta.json", "w"), indent=1)


@torch.no_grad()
def predict_set(model, name, regime, limit=None, scale20=False):
    model.eval()
    ds = DS([name], False, regime); ds.rng = np.random.default_rng(42)
    n = len(ds) if limit is None else min(limit, len(ds))
    P, Yall = [], []
    for s in range(0, n, 32):
        xb, yb = zip(*(ds[i] for i in range(s, min(n, s + 32))))
        x = torch.stack(xb); y = torch.stack(yb)
        if scale20:
            x, y = to20m(x, y)
        P.append(torch.sigmoid(model(x)).numpy().astype(np.float32)); Yall.append(y.numpy() > 0.5)
    return np.concatenate(P), np.concatenate(Yall)


def scores(p, y, thr=0.5):
    pr = p >= thr
    tp = int((pr & y).sum()); fp = int((pr & ~y).sum()); fn = int((~pr & y).sum())
    P = tp / max(tp + fp, 1); R = tp / max(tp + fn, 1)
    return {"IoU": tp / max(tp + fp + fn, 1), "precision": P, "recall": R, "F1": 2 * P * R / max(P + R, 1e-9)}


def evaluate(model, name, regime, limit=None):
    p, y = predict_set(model, name, regime, limit)
    return scores(p, y)


def load_trained():
    model = make_model(False); model.load_state_dict(torch.load(f"{OUT}/unet.pt")); model.eval(); return model


def eval_all():
    model = load_trained(); res = {}
    for name in ("A_test", "B_test"):
        for regime in (None, "landsat", "cloud", "radar_only"):
            key = f"{name}/{regime or 'sentinel2_full'}"
            res[key] = evaluate(model, name, regime); print(key, res[key], file=sys.stderr, flush=True)
        p, y = predict_set(model, name, None, scale20=True)
        res[f"{name}/sentinel2_full_20m"] = scores(p, y); print(name, "20m", res[f"{name}/sentinel2_full_20m"], file=sys.stderr, flush=True)
    # January 2022 only (the month the masks were drawn on), production inputs.
    meta = json.load(open(f"{CACHE}/B_test_meta.json"))
    jan = [i for i, m in enumerate(meta) if m["month"] == "2022-01"]
    p, y = predict_set(model, "B_test", None)
    res["B_test/2022-01_only"] = scores(p[jan], y[jan])
    json.dump(res, open(f"{OUT}/unet_eval.json", "w"), indent=1)


def calibrate():
    """Logistic recalibration per regime, fitted on B training patches (never the test patches)."""
    from sklearn.linear_model import LogisticRegression
    model = load_trained(); out = {}
    for regime, name in ((None, "sentinel2"), ("landsat", "landsat"), ("radar_only", "radar")):
        p, y = predict_set(model, "B_train", regime, limit=600)
        rng = np.random.default_rng(0); idx = rng.choice(p.size, min(400_000, p.size), replace=False)
        q = np.clip(p.ravel()[idx], 1e-6, 1 - 1e-6); z = np.log(q / (1 - q))[:, None]
        lr = LogisticRegression(C=10.0).fit(z, y.ravel()[idx])
        out[name] = {"a": float(lr.coef_[0, 0]), "b": float(lr.intercept_[0])}
        print(name, out[name], file=sys.stderr)
    _, y = predict_set(model, "B_train", None, limit=600)
    json.dump({"calibration": out, "baseRate": float(y.mean())}, open(f"{OUT}/calibration.json", "w"), indent=1)


def export():
    import onnx
    from onnx import helper, numpy_helper, TensorProto
    model = load_trained()

    class WithSigmoid(nn.Module):
        def __init__(self, m):
            super().__init__(); self.m = m

        def forward(self, x):
            return torch.sigmoid(self.m(x))

    x = torch.zeros(1, N_CH, 128, 128)
    path32 = f"{OUT}/gw_mining_unet_fp32.onnx"
    torch.onnx.export(WithSigmoid(model), x, path32, input_names=["x"], output_names=["p"],
                      dynamic_axes={"x": {0: "n", 2: "h", 3: "w"}, "p": {0: "n", 2: "h", 3: "w"}}, opset_version=17, dynamo=False)
    # Store weights as float16 with a Cast back to float32 (computation stays float32): half the file.
    m = onnx.load(path32)
    g = m.graph
    new_inits, casts = [], []
    for init in g.initializer:
        arr = numpy_helper.to_array(init)
        if arr.dtype == np.float32 and arr.size > 16:
            h = numpy_helper.from_array(arr.astype(np.float16), init.name + "_fp16")
            new_inits.append(h)
            casts.append(helper.make_node("Cast", [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + "_cast"))
        else:
            new_inits.append(init)
    del g.initializer[:]
    g.initializer.extend(new_inits)
    nodes = list(g.node); del g.node[:]; g.node.extend(casts + nodes)
    onnx.save(m, f"{OUT}/gw_mining_unet.onnx")
    os.remove(path32)
    norm = json.load(open(f"{OUT}/norm.json"))
    cal = json.load(open(f"{OUT}/calibration.json")) if os.path.exists(f"{OUT}/calibration.json") else {}
    ev = json.load(open(f"{OUT}/unet_eval.json")) if os.path.exists(f"{OUT}/unet_eval.json") else {}
    json.dump({"model": "gw_mining_unet", "version": "3.0", "encoder": ENCODER, "channels": CHANNELS, "mean": norm["mean"], "std": norm["std"],
               "patch": 128, "stride": 96, "threshold": 0.5, "calibration": cal.get("calibration"), "baseRate": cal.get("baseRate"),
               "trainedOn": "SmallMinesDS (Ofori-Ampofo et al., IEEE GRSL 2025) official training split: its own 2016 and 2022 patches plus GhanaWatch composites of Dec 2021-Feb 2022 at the same footprints",
               "metrics": ev},
              open(f"{OUT}/gw_mining_unet.json", "w"), indent=1)
    import onnxruntime as ort
    s = ort.InferenceSession(f"{OUT}/gw_mining_unet.onnx")
    xb = np.random.default_rng(0).normal(size=(2, N_CH, 128, 128)).astype(np.float32)
    a = s.run(None, {"x": xb})[0]
    b = WithSigmoid(model)(torch.from_numpy(xb)).detach().numpy()
    print("exported", os.path.getsize(f"{OUT}/gw_mining_unet.onnx") / 1e6, "MB; max |onnx - torch|", float(np.abs(a - b).max()), file=sys.stderr)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "prep": prep(sys.argv[2] if len(sys.argv) > 2 else "AB")
    elif cmd == "train": train(int(sys.argv[2]) if len(sys.argv) > 2 else 14)
    elif cmd == "eval": eval_all()
    elif cmd == "calibrate": calibrate()
    elif cmd == "export": export()
    elif cmd == "bench":
        m = make_model(True); x = torch.randn(16, N_CH, 128, 128); y = (torch.rand(16, 1, 128, 128) > 0.9).float()
        opt = torch.optim.AdamW(m.parameters()); t = time.time()
        for _ in range(3):
            l = F.binary_cross_entropy_with_logits(m(x), y); opt.zero_grad(); l.backward(); opt.step()
        print(ENCODER, "s/batch16", (time.time() - t) / 3)
