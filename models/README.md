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

`face_detection_yunet_2023mar.onnx` — YuNet (Wu et al., 2023; OpenCV Zoo, MIT licence), the face detector the
report reviewer uses to blur faces in citizen photos before they are published. Its outputs are decoded in
`src/lib/server/reports/image-safety.ts` exactly as OpenCV's `cv::FaceDetectorYN` decodes them; the parity
fixture is made by `research/reports/yunet_reference.py`. SHA-256
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4.

The photo safety classifier (AdamCodd/vit-base-nsfw-detector, Apache-2.0, 8-bit ONNX, 88.5 MB) is not kept
here: the reviewer downloads it from a pinned revision on first use, checks its SHA-256 and caches it under
`DATA_DIR/models`.
