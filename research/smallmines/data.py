"""SmallMinesDS loading shared by the training and evaluation scripts."""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import pandas as pd
import rasterio

from features import build, smallmines_to_inputs

ROOT = os.environ.get("SMALLMINES_ROOT", "/home/claude/data/smallmines")
# Measured by parity_check.py: SmallMinesDS Sentinel-2 values carry the +1000 DN offset of processing
# baseline 04.00 in both years, i.e. reflectance = (DN - 1000) / 10000. Override with SMALLMINES_DN_OFFSET.
DN_OFFSET = float(os.environ.get("SMALLMINES_DN_OFFSET", "1000"))


@dataclass
class Patch:
    pid: str
    year: int
    split: str
    x0: float  # UTM easting of the upper-left corner
    y0: float


def index() -> list[Patch]:
    out: list[Patch] = []
    for year in (2016, 2022):
        df = pd.read_csv(f"{ROOT}/data_splits/train_test_splits_{year}.csv")
        for name, split in zip(df.patch_name, df.split):
            pid = name.split("_")[1]
            path = img_path(pid, year)
            with rasterio.open(path) as r:
                t = r.transform
            out.append(Patch(pid, year, split, t.c, t.f))
    return out


def img_path(pid: str, year: int) -> str:
    return f"{ROOT}/SmallMinesDS/{year}/IMAGE/IMG_GH_{pid}_{year}.tif"


def mask_path(pid: str, year: int) -> str:
    return f"{ROOT}/SmallMinesDS/{year}/MASK/MASK_GH_{pid}_{year}.tif"


def load(p: Patch) -> tuple[np.ndarray, np.ndarray]:
    """Channels (N_CH, 128, 128) before normalisation, and the mask (128, 128) uint8."""
    with rasterio.open(img_path(p.pid, p.year)) as r:
        img = r.read().astype(np.float32)
        nod = r.nodata
    if nod is not None:
        img[img == nod] = np.nan
    refl, vv, vh, dem = smallmines_to_inputs(img, p.year, DN_OFFSET)
    dem = np.where(np.isfinite(dem), dem, np.nanmedian(dem))
    x = build(refl, vv, vh, dem, 10.0)
    with rasterio.open(mask_path(p.pid, p.year)) as r:
        m = r.read(1).astype(np.uint8)
    return x, m


def block_of(p: Patch, km: float = 10.0) -> str:
    """Spatial block id (km x km squares in UTM) for spatially held-out evaluation."""
    return f"{int(p.x0 // (km * 1000))}_{int(p.y0 // (km * 1000))}"
