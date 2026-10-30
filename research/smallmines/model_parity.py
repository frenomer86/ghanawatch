"""Fixture for the model parity test: a crop of one held-out GhanaWatch composite patch (raw channels, stored
as float16) and the trained network's probabilities for it, computed here in PyTorch exactly as the pipeline
computes them in TypeScript (normalise, zero padding to one 128-pixel tile, sigmoid). The test
(tests/unit/ts-model.test.ts) runs the exported ONNX model through src/pipeline/ts/model.ts and must agree.

    python3 model_parity.py   ->  ../../tests/fixtures/model-parity.json
"""
import base64, json, os
import numpy as np, torch
import train_unet as T
from features import normalise

S = 64  # crop size: smaller than a tile, so the padding path is covered too


def main():
    X = np.load(f"{T.CACHE}/B_test_x.npy", mmap_mode="r"); Y = np.load(f"{T.CACHE}/B_test_y.npy", mmap_mode="r")
    share = np.array([(Y[i][:S, :S] > 0.5).mean() for i in range(len(Y))])
    i = int(np.argmin(np.abs(share - 0.3)))  # a crop about one third mining
    raw = np.asarray(X[i][:, :S, :S], np.float16)
    n = json.load(open(f"{T.OUT}/norm.json"))
    x = normalise(raw.astype(np.float32), np.array(n["mean"], np.float32), np.array(n["std"], np.float32))
    pad = np.zeros((T.N_CH, 128, 128), np.float32); pad[:, :S, :S] = x
    model = T.load_trained()
    with torch.no_grad():
        p = torch.sigmoid(model(torch.from_numpy(pad)[None]))[0, 0, :S, :S].numpy().astype(np.float32)
    out = {"patch": i, "w": S, "h": S, "miningShare": float(share[i]),
           "rawF16": base64.b64encode(raw.tobytes()).decode(), "probF32": base64.b64encode(p.tobytes()).decode()}
    path = os.path.join(T.HERE, "..", "..", "tests", "fixtures", "model-parity.json")
    json.dump(out, open(path, "w"))
    print(path, "patch", i, "mining share", round(float(share[i]), 3), "mean p", float(p.mean()))


if __name__ == "__main__":
    main()
