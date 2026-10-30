"""Gradient-boosted pixel classifier on SmallMinesDS: the classical baseline and the band ablation.

Every configuration is trained on the official training patches (both years) and scored on the official
test patches, pixel-wise for the mining class, so the numbers sit beside Table I of Ofori-Ampofo et al.
(2025). A spatially blocked score (20 km squares held out, `spatial`) is reported too, since neighbouring 1.28 km
patches share mines and the official split is random.

    python3 train_gbm.py            # ablation table -> results/gbm_ablation.json
"""
from __future__ import annotations

import json
import os
import sys
import time

import lightgbm as lgb
import numpy as np

from data import index, load, block_of
from features import CHANNELS, box_mean

OUT = os.path.join(os.path.dirname(__file__), "results")
os.makedirs(OUT, exist_ok=True)


def local_std(x, r):
    m = box_mean(x, r)
    m2 = box_mean(x * x, r)
    return np.sqrt(np.clip(m2 - m * m, 0, None))


TEXTURE = ["NDVI_SD5", "MNDWI_SD5", "VV_SD5", "NDVI_M15", "BSI_M15", "MNDWI_M15"]


def pixel_features(x: np.ndarray) -> np.ndarray:
    ci = {c: i for i, c in enumerate(CHANNELS)}
    tex = [
        local_std(x[ci["NDVI"]], 2), local_std(x[ci["MNDWI"]], 2), local_std(x[ci["VV"]], 2),
        box_mean(x[ci["NDVI"]], 7), box_mean(x[ci["BSI"]], 7), box_mean(x[ci["MNDWI"]], 7),
    ]
    f = np.concatenate([x, np.stack(tex)], 0)
    return f.reshape(f.shape[0], -1).T  # (H*W, F)


ALL = CHANNELS + TEXTURE
G = {
    "rgb": ["B04", "B03", "B02"],
    "rgb+": ["B04", "B03", "B02", "B08", "B11", "B12"],
    "s2_all": ["B02", "B03", "B04", "B05", "B06", "B07", "B08", "B8A", "B11", "B12"],
    "indices": ["NDVI", "NDWI", "MNDWI", "BSI", "NDTI", "NBR", "NDRE"],
    "radar": ["VV", "VH", "VH_VV"],
    "terrain": ["SLOPE", "REL_ELEV"],
    "texture": TEXTURE,
}
CONFIGS = {
    "RGB (paper's RF input)": G["rgb"],
    "RGB+ (paper's RF input)": G["rgb+"],
    "All 10 S2 bands": G["s2_all"],
    "+ indices": G["s2_all"] + G["indices"],
    "+ radar VV/VH": G["s2_all"] + G["indices"] + G["radar"],
    "+ terrain": G["s2_all"] + G["indices"] + G["radar"] + G["terrain"],
    "+ texture (full)": G["s2_all"] + G["indices"] + G["radar"] + G["terrain"] + G["texture"],
    "Old detector's inputs (B2,B3,B4,B8,B11 + its 4 indices)": ["B02", "B03", "B04", "B08", "B11", "NDVI", "BSI", "NDWI", "NDTI"],
    "Radar + terrain only (cloud months)": G["radar"] + G["terrain"] + ["VV_SD5"],
    "Landsat-equivalent bands + radar + terrain": ["B02", "B03", "B04", "B8A", "B11", "B12", "NDWI", "MNDWI", "BSI", "NDTI"] + G["radar"] + G["terrain"] + ["MNDWI_SD5", "VV_SD5", "BSI_M15", "MNDWI_M15"],
}


def scores(tp, fp, fn):
    p = tp / max(tp + fp, 1)
    r = tp / max(tp + fn, 1)
    return {"IoU": tp / max(tp + fp + fn, 1), "precision": p, "recall": r, "F1": 2 * p * r / max(p + r, 1e-9)}


def main():
    t0 = time.time()
    patches = index()
    rng = np.random.default_rng(0)
    cache = os.path.join(OUT, "cache"); os.makedirs(cache, exist_ok=True)
    tests = [p for p in patches if p.split == "test"]
    if not os.path.exists(f"{cache}/gbm_test_y.npy"):
        # Test features on disk (float16, memory-mapped): the whole test set never sits in memory.
        XT = np.lib.format.open_memmap(f"{cache}/gbm_test_x.npy", "w+", np.float16, (len(tests), 128 * 128, len(ALL)))
        YT = np.zeros((len(tests), 128 * 128), np.uint8)
        Xtr, ytr = [], []
        k = 0
        for i, p in enumerate(patches):
            x, m = load(p)
            f = pixel_features(x).astype(np.float32)
            y = m.ravel()
            if p.split == "train":
                pos = np.flatnonzero(y == 1); neg = np.flatnonzero(y == 0)
                take = np.concatenate([rng.choice(pos, min(len(pos), 250), replace=False) if len(pos) else pos, rng.choice(neg, min(len(neg), 250), replace=False)])
                Xtr.append(f[take]); ytr.append(y[take])
            else:
                XT[k] = f.astype(np.float16); YT[k] = y; k += 1
            if i % 500 == 0:
                print(f"{i}/{len(patches)} patches, {time.time() - t0:.0f}s", file=sys.stderr)
        XT.flush(); np.save(f"{cache}/gbm_train_x.npy", np.concatenate(Xtr)); np.save(f"{cache}/gbm_train_y.npy", np.concatenate(ytr)); np.save(f"{cache}/gbm_test_y.npy", YT)
    Xtr = np.load(f"{cache}/gbm_train_x.npy"); ytr = np.load(f"{cache}/gbm_train_y.npy")
    XT = np.load(f"{cache}/gbm_test_x.npy", mmap_mode="r"); YT = np.load(f"{cache}/gbm_test_y.npy")
    test = [(None, XT, k) for k in range(len(YT))]
    print(f"train pixels {len(ytr)} ({ytr.mean():.2%} mining), test patches {len(test)}", file=sys.stderr)

    path = os.path.join(OUT, "gbm_ablation.json")
    results = json.load(open(path)) if os.path.exists(path) else {}
    for name, cols in CONFIGS.items():
        if name in results and name != "+ texture (full)":
            continue
        idx = [ALL.index(c) for c in cols]
        model = lgb.LGBMClassifier(n_estimators=400, learning_rate=0.05, num_leaves=63, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1, n_jobs=2)
        model.fit(Xtr[:, idx], ytr)
        tp = fp = fn = 0
        for s0 in range(0, len(YT), 64):
            f = np.asarray(XT[s0:s0 + 64][:, :, idx], np.float32).reshape(-1, len(idx))
            y = YT[s0:s0 + 64].ravel()
            pr = model.predict_proba(f)[:, 1] >= 0.5
            tp += int((pr & (y == 1)).sum()); fp += int((pr & (y == 0)).sum()); fn += int((~pr & (y == 1)).sum())
        results[name] = {"features": cols, **scores(tp, fp, fn)}
        print(f"{name:60s} IoU {results[name]['IoU']:.3f}  P {results[name]['precision']:.3f}  R {results[name]['recall']:.3f}  F1 {results[name]['F1']:.3f}  ({time.time() - t0:.0f}s)", file=sys.stderr)
        if name == "+ texture (full)":
            model.booster_.save_model(os.path.join(OUT, "gbm_full.txt"))
            imp = sorted(zip(cols, model.booster_.feature_importance("gain")), key=lambda t: -t[1])
            results[name]["importance_gain"] = [(c, float(v)) for c, v in imp]
        with open(path, "w") as fh:
            json.dump(results, fh, indent=1)


if __name__ == "__main__" and (len(sys.argv) == 1 or sys.argv[1] == "ablation"):
    main()


def spatial_cv(folds=5, km=20.0):
    """How much the random patch split flatters a model: the full-feature model scored on whole km x km
    squares it never saw (group k-fold over squares), against the official random split."""
    patches = index()
    rng = np.random.default_rng(0)
    groups = sorted({block_of(p, km) for p in patches})
    order = rng.permutation(len(groups))
    fold_of = {g: int(order[i] % folds) for i, g in enumerate(groups)}
    cols = CONFIGS["+ texture (full)"]
    idx = [ALL.index(c) for c in cols]
    # Sample pixels per patch once (features computed once), keep the patch's fold.
    X, Y, F, test = [], [], [], []
    for p in patches:
        x, m = load(p)
        f = pixel_features(x)[:, idx].astype(np.float32)
        y = m.ravel()
        pos = np.flatnonzero(y == 1); neg = np.flatnonzero(y == 0)
        take = np.concatenate([rng.choice(pos, min(len(pos), 120), replace=False) if len(pos) else pos, rng.choice(neg, min(len(neg), 120), replace=False)])
        X.append(f[take]); Y.append(y[take]); F.append(np.full(len(take), fold_of[block_of(p, km)]))
        sub = rng.choice(len(y), 2048, replace=False)  # scoring sample per patch (all pixels would not fit in memory)
        test.append((fold_of[block_of(p, km)], f[sub].astype(np.float16), y[sub]))
    X = np.concatenate(X); Y = np.concatenate(Y); F = np.concatenate(F)
    tp = fp = fn = 0
    per = []
    for k in range(folds):
        model = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=63, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1, n_jobs=2)
        model.fit(X[F != k], Y[F != k])
        a = b = c = 0
        for fk, f, y in test:
            if fk != k:
                continue
            pr = model.predict_proba(f.astype(np.float32))[:, 1] >= 0.5
            a += int((pr & (y == 1)).sum()); b += int((pr & (y == 0)).sum()); c += int((~pr & (y == 1)).sum())
        per.append(scores(a, b, c)); tp += a; fp += b; fn += c
        print(f"fold {k}: {per[-1]}", file=sys.stderr, flush=True)
    res = {"squaresKm": km, "folds": folds, "squares": len(groups), "pooled": scores(tp, fp, fn), "perFold": per}
    json.dump(res, open(os.path.join(OUT, "gbm_spatial_cv.json"), "w"), indent=1)
    print(json.dumps(res["pooled"]), file=sys.stderr)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "spatial":
    spatial_cv()
