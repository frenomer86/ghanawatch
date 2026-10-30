# Models

`gw_mining_unet.onnx` — the mining-state model of detector 3.0 (U-Net, ResNet-18 encoder, 24 input channels,
output P(mining footprint) per pixel). Weights are stored as float16 and cast to float32 inside the graph.

`gw_mining_unet.json` — its metadata: input channel order, normalisation, tile size and stride, per-regime
calibration, base rate, training data and test metrics. The pipeline refuses a model whose channels differ
from `src/pipeline/ts/features.ts`.

Rebuild: `research/smallmines/train_unet.py` (prep, train, eval, calibrate, export), then copy
`results/gw_mining_unet.onnx` and `results/gw_mining_unet.json` here. See `docs/detector.md`.

Trained on SmallMinesDS (Ofori-Ampofo et al., IEEE GRSL 2025, CC BY-SA 4.0); the model is a derived work and
is shared under the same licence.
