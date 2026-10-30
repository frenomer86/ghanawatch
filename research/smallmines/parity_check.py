"""Compare a SmallMinesDS 2022 patch with a January 2022 median composite built from Earth Search COGs.

Decides the DN scale of SmallMinesDS (whether its Sentinel-2 values carry the +1000 offset of
processing baseline 04.00) so the classifier trained on it can be applied to GhanaWatch composites.
"""
import glob, json, random, sys, urllib.request
import numpy as np, rasterio
from rasterio.windows import from_bounds
from rasterio.warp import transform_bounds

BANDS = ["blue", "green", "red", "rededge1", "rededge2", "rededge3", "nir", "nir08", "swir16", "swir22"]
STAC = "https://earth-search.aws.element84.com/v1/search"

def search(bbox, dt):
    body = json.dumps({"collections": ["sentinel-2-l2a"], "bbox": bbox, "datetime": dt, "limit": 100}).encode()
    req = urllib.request.Request(STAC, body, {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))["features"]

def read(href, bounds, shape):
    with rasterio.open(href) as r:
        w = from_bounds(*bounds, transform=r.transform)
        return r.read(1, window=w, out_shape=shape, boundless=True, fill_value=0, resampling=rasterio.enums.Resampling.nearest)

def main(n=6, seed=1):
    random.seed(seed)
    files = sorted(glob.glob("/home/claude/data/smallmines/SmallMinesDS/2022/IMAGE/*.tif"))
    rows = []
    for f in random.sample(files, n):
        with rasterio.open(f) as r:
            ref = r.read()[:10].astype(np.float32); b = r.bounds; crs = r.crs
        bbox = list(transform_bounds(crs, "EPSG:4326", *b))
        feats = [x for x in search(bbox, "2022-01-01T00:00:00Z/2022-01-31T23:59:59Z") if (x["properties"].get("proj:code") or f"EPSG:{x['properties'].get('proj:epsg')}") == str(crs)]
        stack = []
        for x in feats:
            scl = read(x["assets"]["scl"]["href"], b, (128, 128))
            ok = np.isin(scl, [4, 5, 6])
            if ok.mean() < 0.5: continue
            off = x["assets"]["red"].get("raster:bands", [{}])[0].get("offset", 0) or 0
            arr = np.stack([read(x["assets"][k]["href"], b, (128, 128)).astype(np.float32) for k in BANDS])
            # to reflectance with the scene's own offset
            refl = arr * 1e-4 + off
            refl[:, ~ok] = np.nan
            stack.append(refl)
        if not stack: continue
        mine = np.nanmedian(np.stack(stack), 0)
        for i, k in enumerate(BANDS):
            m = np.isfinite(mine[i])
            if m.sum() < 500: continue
            a = ref[i][m]; c = mine[i][m]
            # fit ref_DN = alpha * refl + beta
            A = np.vstack([c, np.ones_like(c)]).T
            alpha, beta = np.linalg.lstsq(A, a, rcond=None)[0]
            rows.append((k, float(np.corrcoef(a, c)[0, 1]), float(alpha), float(beta), float(np.median(a)), float(np.median(c))))
        print(f, len(stack), "clear scenes", file=sys.stderr)
    import collections
    agg = collections.defaultdict(list)
    for r in rows: agg[r[0]].append(r[1:])
    print("band      corr   DN-per-refl   intercept   medDN   medRefl")
    for k in BANDS:
        if not agg[k]: continue
        v = np.array(agg[k]); print(f"{k:9s} {np.median(v[:,0]):.3f}  {np.median(v[:,1]):9.0f}  {np.median(v[:,2]):9.0f}  {np.median(v[:,3]):7.0f}  {np.median(v[:,4]):.4f}")

if __name__ == "__main__":
    main()
