"""Score the old and new detectors against the SmallMinesDS January 2022 expert masks on held-out patches.

    python3 research/eval/score.py --eval=/path/to/eval --blocks=b2_3,b3_3 [--month=2022-01]

Compared on the official test patches inside the evaluated blocks (never used in training):
  new, one month       U-Net on the January 2022 composite alone (calibrated P >= 0.5)
  new, tracker now     tracker state after January 2022: P(mined) >= 0.5
  new, tracker ever    any pixel the tracker dated as mined since the start (includes regrown)
  old, cumulative      every pixel the two-date scan flagged in any monthly run from 2020-01 to 2022-01
Reported for all mining in the 2022 mask, and for "new mining" (in the 2022 mask, not in the 2016 mask),
the only kind a change detector is designed to find. Onset dates are checked against the two masks:
mines already there in 2016 should be dated at the start of the record, new ones later.
"""
import argparse, json, os, sys
import numpy as np, rasterio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "smallmines"))
from data import mask_path  # noqa: E402

EPOCH = 2013
mi = lambda m: (int(m[:4]) - EPOCH) * 12 + int(m[5:7]) - 1
mn = lambda i: f"{EPOCH + i // 12}-{i % 12 + 1:02d}"


def scores(pred, ref):
    tp = int((pred & ref).sum()); fp = int((pred & ~ref).sum()); fn = int((~pred & ref).sum())
    P = tp / max(tp + fp, 1); R = tp / max(tp + fn, 1)
    return {"IoU": round(tp / max(tp + fp + fn, 1), 4), "precision": round(P, 4), "recall": round(R, 4), "F1": round(2 * P * R / max(P + R, 1e-9), 4), "tp": tp, "fp": fp, "fn": fn}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--eval"); ap.add_argument("--blocks"); ap.add_argument("--month", default="2022-01")
    ap.add_argument("--blocks-file", default=os.path.join(HERE, "..", "smallmines", "blocks_2022.json"))
    a = ap.parse_args()
    blocks = {b["id"]: b for b in json.load(open(a.blocks_file))}
    acc = {k: [] for k in ("ref", "ref16", "one", "now", "ever", "old", "onset")}
    for bid in a.blocks.split(","):
        b = blocks[bid]; d = os.path.join(a.eval, bid)
        prob = np.load(os.path.join(d, "prob", f"{a.month}.npy")) if os.path.exists(os.path.join(d, "prob", f"{a.month}.npy")) else None
        p1 = np.load(os.path.join(d, "p1.npy")) if os.path.exists(os.path.join(d, "p1.npy")) else None
        onset = np.load(os.path.join(d, "onset.npy")) if os.path.exists(os.path.join(d, "onset.npy")) else None
        old = np.load(os.path.join(d, "old_first.npy")) if os.path.exists(os.path.join(d, "old_first.npy")) else None
        for p in b["patches"]:
            if p["split"] != "test":
                continue
            ys, xs = slice(p["row"] * 128, p["row"] * 128 + 128), slice(p["col"] * 128, p["col"] * 128 + 128)
            ref = rasterio.open(mask_path(p["pid"], 2022)).read(1) > 0
            f16 = mask_path(p["pid"], 2016)
            ref16 = rasterio.open(f16).read(1) > 0 if os.path.exists(f16) else np.zeros_like(ref)
            acc["ref"].append(ref); acc["ref16"].append(ref16)
            acc["one"].append(((prob[ys, xs].astype(np.float32) - 1) / 254 >= 0.5) & (prob[ys, xs] > 0) if prob is not None else np.zeros_like(ref))
            acc["now"].append(p1[ys, xs] >= 0.5 if p1 is not None else np.zeros_like(ref))
            acc["ever"].append(onset[ys, xs] >= 0 if onset is not None else np.zeros_like(ref))
            acc["onset"].append(onset[ys, xs] if onset is not None else np.full(ref.shape, -1.0))
            acc["old"].append((old[ys, xs] >= 0) & (old[ys, xs] <= mi(a.month)) if old is not None else np.zeros_like(ref))
    R = {k: np.stack(v) for k, v in acc.items()}
    ref, ref16 = R["ref"], R["ref16"]
    new_mining = ref & ~ref16
    out = {"patches": int(ref.shape[0]), "minedPixels2022": int(ref.sum()), "newMiningPixels2016to2022": int(new_mining.sum()), "methods": {}}
    for k, label in (("one", "new: U-Net, January 2022 alone"), ("now", "new: tracker, mined in January 2022"), ("ever", "new: tracker, mined at any time since the start"), ("old", "old: two-date scan, any monthly run 2020-01 to 2022-01")):
        out["methods"][label] = {"all mining (2022 mask)": scores(R[k], ref), "recall on new mining since 2016": round(float((R[k] & new_mining).sum() / max(new_mining.sum(), 1)), 4)}
    on = R["onset"]
    if (on >= 0).any():
        pre = ref16 & (on >= 0); nw = new_mining & (on >= 0)
        start = int(on[on >= 0].min())
        out["onset"] = {
            "trackerStart": mn(start),
            "mines already in 2016: share dated in the first 3 months of the record": round(float((on[pre] <= start + 2).mean()) if pre.any() else float("nan"), 4),
            "new mines (2016-2022): share dated in the first 3 months": round(float((on[nw] <= start + 2).mean()) if nw.any() else float("nan"), 4),
            "new mines: onset months (median, p10, p90)": [mn(int(np.median(on[nw]))), mn(int(np.percentile(on[nw], 10))), mn(int(np.percentile(on[nw], 90)))] if nw.any() else None,
        }
    print(json.dumps(out, indent=1))
    json.dump(out, open(os.path.join(a.eval, "score.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
