"""Model input channels for the GhanaWatch mining-state model (feature set v1).

This file is the reference definition. src/pipeline/ts/features.ts computes the same channels in the
same order from GhanaWatch monthly composites, and tests/unit/ts-features.test.ts checks the two agree
on fixture pixels exported by export_parity_fixture() below.

Optical inputs are surface reflectance (0-1). Radar inputs are backscatter in dB. Elevation is metres.
"""
from __future__ import annotations

import numpy as np

S2_BANDS = ["B02", "B03", "B04", "B05", "B06", "B07", "B08", "B8A", "B11", "B12"]
CHANNELS = [
    *S2_BANDS,
    "NDVI", "NDWI", "MNDWI", "BSI", "NDTI", "NBR", "NDRE",
    "VV", "VH", "VH_VV",
    "SLOPE", "REL_ELEV",
    "OPT_OK", "RE_OK",
]
N_CH = len(CHANNELS)
OPTICAL = list(range(0, 17))  # bands and indices that need an optical observation
RED_EDGE = [3, 4, 5, 16]  # B05 B06 B07 NDRE: Sentinel-2 only (absent from Landsat)
RADAR = [17, 18, 19]
REL_ELEV_RADIUS = 15  # pixels: relative elevation = DEM minus the mean over a 31 x 31 window
EPS = 1e-6


def nd(a, b):
    """Normalised difference on reflectances clamped at 0, clipped to [-1, 1] (as features.ts)."""
    a = np.clip(a, 0, None); b = np.clip(b, 0, None)
    return np.clip((a - b) / (a + b + EPS), -1, 1)


def box_mean(x: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)^2 window with edge replication, via an integral image (matches the TS version)."""
    h, w = x.shape
    p = np.pad(x.astype(np.float64), r, mode="edge")
    ii = np.zeros((p.shape[0] + 1, p.shape[1] + 1))
    ii[1:, 1:] = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = ii[k:k + h, k:k + w] - ii[0:h, k:k + w] - ii[k:k + h, 0:w] + ii[0:h, 0:w]
    return (s / (k * k)).astype(np.float32)


def slope_deg(dem: np.ndarray, res: float) -> np.ndarray:
    """Slope in degrees with central differences and edge replication (Horn-free, matches the TS version)."""
    p = np.pad(dem.astype(np.float64), 1, mode="edge")
    dzdx = (p[1:-1, 2:] - p[1:-1, :-2]) / (2 * res)
    dzdy = (p[2:, 1:-1] - p[:-2, 1:-1]) / (2 * res)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype(np.float32)


def build(refl: np.ndarray | None, vv_db: np.ndarray, vh_db: np.ndarray, dem: np.ndarray, res: float = 10.0,
          opt_ok: np.ndarray | None = None, re_ok: np.ndarray | None = None) -> np.ndarray:
    """Channels (N_CH, H, W) as float32, before normalisation.

    refl: (10, H, W) reflectance in S2_BANDS order, NaN where there is no optical observation.
    opt_ok / re_ok: per-pixel availability (default: finite optical, red edge present wherever optical is).
    """
    h, w = dem.shape
    out = np.zeros((N_CH, h, w), np.float32)
    if refl is not None:
        b = {k: refl[i] for i, k in enumerate(S2_BANDS)}
        out[0:10] = refl
        out[10] = nd(b["B08"], b["B04"])
        out[11] = nd(b["B03"], b["B08"])
        out[12] = nd(b["B03"], b["B11"])
        P = {k: np.clip(v, 0, None) for k, v in b.items()}
        out[13] = np.clip(((P["B11"] + P["B04"]) - (P["B08"] + P["B02"])) / ((P["B11"] + P["B04"]) + (P["B08"] + P["B02"]) + EPS), -1, 1)
        out[14] = nd(b["B04"], b["B03"])
        out[15] = nd(b["B08"], b["B12"])
        out[16] = nd(b["B8A"], b["B05"])
        if opt_ok is None:
            opt_ok = np.isfinite(refl).all(0)
        if re_ok is None:
            re_ok = opt_ok.copy()
    else:
        opt_ok = np.zeros((h, w), bool)
        re_ok = np.zeros((h, w), bool)
    out[17] = vv_db
    out[18] = vh_db
    out[19] = vh_db - vv_db
    out[20] = slope_deg(dem, res)
    out[21] = dem - box_mean(dem, REL_ELEV_RADIUS)
    out[22] = opt_ok
    out[23] = re_ok
    out[np.isnan(out)] = 0.0
    return out


def normalise(x: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    """Standardise each channel; channels with no observation (flags 0) are set to 0, the training mean."""
    y = (x - mean[:, None, None]) / std[:, None, None]
    opt = x[22] > 0.5
    re = x[23] > 0.5
    for c in OPTICAL:
        y[c][~opt] = 0.0
    for c in RED_EDGE:
        y[c][~re] = 0.0
    y[22] = x[22]
    y[23] = x[23]
    rad_ok = np.isfinite(x[17]) & (x[17] != 0)
    for c in RADAR:
        y[c][~rad_ok] = 0.0
    return y.astype(np.float32)


# --- SmallMinesDS patches ------------------------------------------------------------------------

def smallmines_to_inputs(img: np.ndarray, year: int, dn_offset: float):
    """Split a 13-band SmallMinesDS patch into (reflectance, VV dB, VH dB, DEM).

    Sentinel-2 bands are digital numbers; reflectance = (DN - dn_offset) / 10000, where dn_offset is
    measured against GhanaWatch composites by parity_check.py. Radar is dB in the 2016 patches and
    linear power in the 2022 patches, so 2022 is converted.
    """
    s2 = img[:10].astype(np.float32)
    refl = (s2 - dn_offset) / 10000.0
    refl[s2 <= 0] = np.nan
    vv = img[10].astype(np.float32)
    vh = img[11].astype(np.float32)
    if year == 2022 or np.nanmedian(vv) > 0:
        vv = 10 * np.log10(np.clip(vv, 1e-5, None))
        vh = 10 * np.log10(np.clip(vh, 1e-5, None))
    dem = img[12].astype(np.float32)
    return refl, vv, vh, dem
