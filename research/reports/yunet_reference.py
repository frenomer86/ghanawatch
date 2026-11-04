"""Reference face detections from OpenCV's own YuNet decoder (cv2.FaceDetectorYN), for the parity test of
src/lib/server/reports/image-safety.ts, which decodes the same ONNX outputs in TypeScript.

    python3 research/reports/yunet_reference.py <image> <out.json> [score_threshold]
    python3 research/reports/yunet_reference.py synthetic:34 tests/fixtures/faces/cartoon.json 0.3

"synthetic:<seed>" draws the committed test picture: flat cartoon faces (ellipses with eyes and a mouth) that
YuNet scores between 0.3 and 0.9, so the parity test covers the decoder, the score threshold and the overlap
suppression without committing anyone's photograph.

The image is letterboxed exactly as image-safety.ts does (longest side 640, padded right and bottom with black),
saved next to the JSON as the 640 x 640 PNG the TypeScript test reads, and run through cv2 with the same score and
overlap thresholds.
"""
import json, os, sys
import cv2, numpy as np

MODEL = os.path.join(os.path.dirname(__file__), "..", "..", "models", "face_detection_yunet_2023mar.onnx")


def letterbox(img, size=640):
    h, w = img.shape[:2]
    s = size / max(h, w)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    out = np.zeros((size, size, 3), np.uint8)
    out[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    return out


def synthetic(seed):
    rng = np.random.default_rng(seed)
    img = np.full((640, 640, 3), rng.integers(60, 200, 3), np.uint8)
    for _ in range(rng.integers(3, 9)):
        cx, cy = rng.integers(40, 600, 2); a = int(rng.integers(14, 90)); b = int(a * 1.25)
        col = tuple(int(x) for x in rng.integers(90, 230, 3))
        cv2.ellipse(img, (int(cx), int(cy)), (a, b), 0, 0, 360, col, -1)
        e = max(2, a // 5)
        cv2.circle(img, (int(cx - a * 0.4), int(cy - b * 0.2)), e, (30, 30, 30), -1)
        cv2.circle(img, (int(cx + a * 0.4), int(cy - b * 0.2)), e, (30, 30, 30), -1)
        cv2.ellipse(img, (int(cx), int(cy + b * 0.45)), (max(3, a // 3), max(2, a // 8)), 0, 0, 360, (40, 40, 120), -1)
    return cv2.GaussianBlur(img, (5, 5), 1.2)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    thr = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
    img = synthetic(int(src.split(":")[1])) if src.startswith("synthetic:") else cv2.imread(src, cv2.IMREAD_COLOR)
    if img.shape[:2] != (640, 640):
        img = letterbox(img)
    png = os.path.splitext(dst)[0] + ".png"
    cv2.imwrite(png, img)
    det = cv2.FaceDetectorYN.create(MODEL, "", (640, 640), score_threshold=thr, nms_threshold=0.3, top_k=5000)
    _, faces = det.detect(img)
    faces = [] if faces is None else faces.tolist()
    json.dump({"image": os.path.basename(png), "scoreThreshold": thr, "nmsThreshold": 0.3,
               "faces": [{"x": f[0], "y": f[1], "w": f[2], "h": f[3], "score": f[14]} for f in faces]}, open(dst, "w"), indent=1)
    print(len(faces), "faces", [round(f[14], 3) for f in faces])


if __name__ == "__main__":
    main()
