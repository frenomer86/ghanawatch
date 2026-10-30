"""Choose the tracker's onset rule and evidence weights on validation blocks, never on the test blocks.

    python3 research/eval/tracker_sweep.py --eval=/home/claude/data/val --blocks=b1_4,b2_5

The monthly probabilities that research/eval/temporal-eval.ts saved (prob/YYYY-MM.npy, calibrated, uint8 with
0 = no observation) and the regimes of the cached composites (cube/YYYY-MM_regime.npy) are replayed through a
NumPy port of src/pipeline/ts/tracker.ts step(), for each candidate setting, and scored on the official test
patches of the validation blocks (never used in training) against the SmallMinesDS January 2022 masks, as
research/eval/score.py scores the test blocks. Writes <eval>/tracker_sweep.json.

Onset rules:
  calibrated  a run of mining-looking months starts at calibrated P >= 0.5 and any month below 0.5 ends it
              (the first version);
  evidence    a run starts at the first month whose evidence favours mining over the model's prior (odds
              ratio >= 1), and only an optical month whose evidence favours no mining ends it; radar-only
              months, which see through cloud but see less, never end a run.
"""
import argparse, glob, itertools, json, os, sys
import numpy as np, rasterio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "smallmines"))
from data import mask_path  # noqa: E402

EPOCH = 2013
mi = lambda m: (int(m[:4]) - EPOCH) * 12 + int(m[5:7]) - 1


def replay(months, probs, regimes, prior, w, onset_rule, a=0.002, r=0.01, b=0.03, init=0.02, thr=0.5, clamp=0.02):
    n = probs[0].size
    p0 = np.full(n, 1 - init); p1 = np.full(n, init); p2 = np.zeros(n)
    onset = np.full(n, -1); run = np.full(n, -1)
    prior_odds = prior / (1 - prior)
    for m, q, reg in zip(months, probs, regimes):
        q = q.ravel(); reg = reg.ravel()
        n0 = p0 * (1 - a); n1 = p0 * a + p1 * (1 - r) + p2 * b; n2 = p1 * r + p2 * (1 - b)
        obs = (q > 0) & (reg > 0)
        pc = np.clip((q.astype(np.float64) - 1) / 254, clamp, 1 - clamp)
        orat = (pc / (1 - pc)) / prior_odds
        wt = np.select([reg == 1, reg == 2, reg == 3], [w[0], w[1], w[2]], 0.0)
        n1 = np.where(obs, n1 * orat ** wt, n1)
        free = onset < 0
        if onset_rule == "calibrated":
            start = obs & (pc >= 0.5); stop = obs & (pc < 0.5)
        else:
            optical = (reg == 1) | (reg == 2)
            start = obs & (orat >= 1); stop = obs & optical & (orat < 1)
        run = np.where(start & (run < 0), m, run)
        run = np.where(stop & ~start & free, -1, run)
        z = n0 + n1 + n2; p0, p1, p2 = n0 / z, n1 / z, n2 / z
        hit = (p1 >= thr) & (onset < 0)
        onset = np.where(hit, np.where(run >= 0, run, m), onset)
    return p1, onset


def scores(pred, ref):
    tp = int((pred & ref).sum()); fp = int((pred & ~ref).sum()); fn = int((~pred & ref).sum())
    P = tp / max(tp + fp, 1); R = tp / max(tp + fn, 1)
    return {"IoU": round(tp / max(tp + fp + fn, 1), 4), "precision": round(P, 4), "recall": round(R, 4), "F1": round(2 * P * R / max(P + R, 1e-9), 4)}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--eval", required=True); ap.add_argument("--blocks", required=True)
    ap.add_argument("--model", default=os.path.join(HERE, "..", "..", "models", "gw_mining_unet.json"))
    ap.add_argument("--only", help="JSON of one setting to score (for the final test run)")
    a = ap.parse_args()
    prior = json.load(open(a.model))["baseRate"]
    blocks = {b["id"]: b for b in json.load(open(os.path.join(HERE, "..", "smallmines", "blocks_2022.json")))}
    data = []
    for bid in a.blocks.split(","):
        d = os.path.join(a.eval, bid)
        ms = sorted(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(d, "prob", "*.npy")))
        probs = [np.load(os.path.join(d, "prob", f"{m}.npy")) for m in ms]
        regs = [np.load(os.path.join(d, "cube", f"{m}_regime.npy")) for m in ms]
        h, w = probs[0].shape
        sel = np.zeros((h, w), bool); ref = np.zeros((h, w), bool); ref16 = np.zeros((h, w), bool)
        for p in blocks[bid]["patches"]:
            if p["split"] != "test":
                continue
            ys, xs = slice(p["row"] * 128, p["row"] * 128 + 128), slice(p["col"] * 128, p["col"] * 128 + 128)
            sel[ys, xs] = True
            ref[ys, xs] = rasterio.open(mask_path(p["pid"], 2022)).read(1) > 0
            f16 = mask_path(p["pid"], 2016)
            if os.path.exists(f16):
                ref16[ys, xs] = rasterio.open(f16).read(1) > 0
        data.append(([mi(m) for m in ms], probs, regs, sel.ravel(), ref.ravel(), ref16.ravel()))
    grid = [json.loads(a.only)] if a.only else [
        {"rule": rule, "w": list(w), "thr": thr}
        for rule in ("calibrated", "evidence")
        for w in ((0.55, 0.45, 0.25), (0.8, 0.7, 0.35), (1.0, 0.9, 0.5))
        for thr in (0.5, 0.7)
    ]
    out = []
    for g in grid:
        P1, ON, REF, REF16 = [], [], [], []
        for months, probs, regs, sel, ref, ref16 in data:
            p1, onset = replay(months, probs, regs, prior, g["w"], g["rule"], thr=g["thr"])
            P1.append(p1[sel]); ON.append(onset[sel]); REF.append(ref[sel]); REF16.append(ref16[sel])
        p1 = np.concatenate(P1); on = np.concatenate(ON); ref = np.concatenate(REF); ref16 = np.concatenate(REF16)
        start = min(d[0][0] for d in data)
        new = ref & ~ref16
        pre = ref16 & ref & (on >= 0)
        res = {**g, "now": scores(p1 >= g["thr"], ref), "recallNewMining": round(float(((p1 >= g["thr"]) & new).sum() / max(new.sum(), 1)), 4),
               "preexistingDatedAtStart": round(float((on[pre] <= start + 2).mean()), 4) if pre.any() else None}
        out.append(res)
        print(json.dumps(res), flush=True)
    json.dump(out, open(os.path.join(a.eval, "tracker_sweep.json" if not a.only else "tracker_final.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
