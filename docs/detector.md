# GhanaWatch galamsey detector 3.0 (multi-sensor monthly record)

Method version `s2-galamsey-3.0`, live source `gw-multisensor`, Galamsey Index version 2.0.
Code: `src/pipeline/ts/*`, `src/pipeline/adapters/timeseries.ts`, `src/pipeline/history/timeseries.ts`.
Research and training: `research/smallmines/*`, evaluation: `research/eval/*`.

## 1. What changed from 2.x

| | 2.x (two-date scan) | 3.0 (monthly record) |
|---|---|---|
| Dates compared | two composites: last 120 days vs one to two years earlier | every month since 2017, per pixel |
| Sentinel-2 bands | 5 (B2, B3, B4, B8, B11) | all 10 (B2–B8A, B11, B12) |
| Indices | NDVI, BSI, NDWI, NDTI | NDVI, NDWI, MNDWI, BSI, NDTI, NBR, NDRE, VH−VV |
| Cloud handling | scene classification + haze limit | scene classification + haze limit + per-pixel two-pass screen (haze and unflagged shadow) |
| Landsat 8/9 | not used | fills months Sentinel-2 could not see, HLS cross-calibrated |
| Sentinel-1 radar | VV only, new ponds only, cells under 40% optical cover, 40 cells per run | VV and VH, every cell, every month, an input of the model |
| Terrain | none | slope and height above the surrounding ground (Copernicus DEM) |
| Decision | fixed thresholds | U-Net trained on hand-mapped Ghanaian mines, then a per-pixel hidden Markov tracker |
| Resolution | 20 m (gold belt), 40 m | 10 m (gold belt), 20 m elsewhere; tracker at 20 m |
| Output | a detection when the two dates differ | a dated history per site: onset month, area by month, spreading or regrown |
| Index | a site's first outline, in the month first seen | the area each site adds, in the month it is confirmed |

The 2.x scan still runs for one job: muddy rivers in the mining belt (river pages). The radar adapter keeps
its river watch for dredgers. Set `GW_DETECTOR=legacy` to return to 2.x completely.

## 2. Monthly composite (`ts/composite.ts`)

For a block (up to 1,024 × 1,024 pixels) and a calendar month:

1. **Sentinel-2 L2A** (Element84 Earth Search, keyless): every scene of the month with under 95% cloud,
   clearest first, up to 12. Each band is read with windowed range requests at the block resolution
   (nearest pixel). An observation is kept where the scene classification is vegetation, bare soil or water
   (4, 5, 6), blue reflectance is at most 0.12, and NIR is positive. Overlapping tiles of the same pass count
   once. Second pass, for pixels with three or more observations: drop any whose blue is more than 0.04 above
   the pixel's own monthly median (haze, thin cloud) or whose NIR and SWIR1 are both below 60% of their medians
   (unflagged cloud shadow). Each band's median of what remains is the composite.
2. **Landsat 8/9 Collection 2 Level-2** (Microsoft Planetary Computer, keyless token): only for pixels with no
   Sentinel-2 observation all month. QA_PIXEL keeps clear or water and drops fill, dilated cloud, cirrus, cloud
   and shadow. Surface reflectance (DN × 2.75e-5 − 0.2) is put on the Sentinel-2 scale by inverting the HLS
   bandpass adjustment (Claverie et al., 2018): blue, green, red, NIR (as B8A and B8), SWIR1, SWIR2. Red edge
   stays empty and the model is told (`RE_OK = 0`).
3. **Sentinel-1 RTC** (Planetary Computer): median VV and VH backscatter in dB of every pass in the month (up to 10).
4. **Copernicus DEM GLO-30**: slope (degrees) and relative elevation (DEM minus its 31 × 31-pixel mean).

## 3. Model input (`ts/features.ts`, reference `research/smallmines/features.py`)

24 channels: 10 bands; NDVI, NDWI, MNDWI, BSI, NDTI, NBR, NDRE; VV, VH, VH−VV; slope, relative elevation;
`OPT_OK`, `RE_OK`. Standardised with means and standard deviations from GhanaWatch composites; unobserved
optical, red-edge or radar values are set to the mean (0) and flagged. A unit test checks the TypeScript and
Python implementations agree number for number on a fixture.

## 4. Model (`ts/model.ts`, `research/smallmines/train_unet.py`)

U-Net with a ResNet-18 encoder (ImageNet initialisation), 24 inputs, one output (P(mining footprint)).

**Training data.** SmallMinesDS (Ofori-Ampofo et al., *IEEE GRSL* 22, 2025, doi:10.1109/LGRS.2025.3566356;
CC BY-SA 4.0): 4,270 hand-mapped 128 × 128 patches at 10 m over five districts of south-western Ghana, January
2016 and January 2022, with the authors' 70/30 train/test split. Two kinds of input share its masks:
(A) its own patches, and (B) GhanaWatch's own January 2022 composites at the same footprints, built by the
production code (`npm run detector:cube`), so the model learns the inputs it will see. A parity check
(`parity_check.py`) on January 2022 patches found the two agree closely (correlation 0.94–0.98 in red, NIR
and SWIR; 0.78–0.92 in blue and green, where compositing differs most) and fixed SmallMinesDS's scale:
reflectance = (DN − 1000) / 10000. Radar in the 2022 patches is linear power and in 2016 dB; both are
converted to dB.

**A bug found on the way (fixed in 2.x and 3.0).** Since processing baseline 04.00 (25 January 2022) Earth
Search serves Sentinel-2 L2A with ESA's +1000 already removed (`earthsearch:boa_offset_applied: true`) but
still advertises an offset of −0.1. GhanaWatch applied it, so every Sentinel-2 reflectance from 2022 on was
read 0.1 too low (over half of the blue band negative). Both detectors now apply the offset only when the
flag is false (`ts/catalog.ts` `s2Offset`, `s2/stac.ts`); a unit test covers it. The 2.x thresholds were
tuned on the biased values, so the muddy-river check should be re-verified on its next accuracy sample.

**Robustness to what a month offers.** Training hides channel groups the way months do: Landsat only (no red
edge, NIR from B8A), radar only, random cloud holes inside a patch; and 20% of batches are averaged to 20 m.

**Loss and optimiser.** Binary cross-entropy (positive weight 3) plus Dice, AdamW, one-cycle learning rate.

**Calibration.** Per regime (Sentinel-2, Landsat, radar only) a logistic recalibration of the output is fitted
on training patches, and the training base rate is recorded; the tracker uses both.

**Export.** ONNX, weights stored as float16 with a cast to float32 (half the file; computation in float32).
Runs with `onnxruntime-node`, an optional dependency of the pipeline image (`.npmrc` skips its GPU download).
Large grids are cut into overlapping 128-pixel tiles blended with a tent weight.

## 5. Tracker (`ts/tracker.ts`)

Per 20 m pixel, three states: not mined, mined, regrown. Monthly transitions: onset 0.2%, regrowth 1%,
re-mining 3%. Evidence: the calibrated probability as a likelihood ratio against the model's base rate,
tempered by how far one month of that sensor is trusted (Sentinel-2 0.55, Landsat 0.45, radar only 0.25);
a month without any observation only moves the chain forward. A pixel is mined when P(mined) ≥ 0.5. Its
onset is the first month of the run of mining-looking observations that carried it over, and never moves.
The state of every cell is saved (gzip) after each month.

## 6. Sites and outputs (`ts/sites.ts`, `adapters/timeseries.ts`)

8-connected mined pixels of at least 0.3 ha form a site. For each: area, onset (10th percentile of its pixels'
onsets), mined area by onset month, area spreading in the last three months, mean P(mined), months observed,
and an anchor (the centre of its earliest pixels) that names it stably as it grows.

- `change_events`: one detection per site as it stands now (method `s2-galamsey-3.0`, signature `mining`),
  with `first_image_date` = onset, before and latest Sentinel-2 images, confidence from mean P(mined) and
  months observed (the savannah north stays low unless very strong).
- `history_events`: for each finished month, one row per site that grew, with the area newly confirmed that
  month (`properties.cohort = true`). Written once; this is what the index counts.

## 7. Galamsey Index 2.0 (`lib/domain/index.ts`, `lib/domain/sites.ts`)

New hectares in a month = the area newly confirmed that month (new sites and the spread of existing ones).
A closed month never changes: rows are written only for finished months and confirmations happen only in
the month being processed. Onset months are kept for maps and analysis. Months before 2019 are the tracker's
burn-in: mining that already existed in 2019 is not counted as new.

## 8. Running it

Live (pipeline service, every 3 h): `npm run pipeline` runs `gw-multisensor` among the other sources. Each run
brings cells up to the last finished month, furthest behind first, then previews the month in progress
(after its tenth day, at most every five days per cell). Environment: `GW_TS_BUDGET_MINUTES` (60),
`GW_TS_CELLS`, `GW_TS_PREVIEW=0`, `GW_TS_GOLD_RES=20`, `GW_MODEL_DIR` (`models/`), `GW_TS_DIR` (`.data/ts`).

Backfill: `npm run pipeline:history-ts -- --to=2026-09 --priority=2 --concurrency=2`, resumable; on a
second machine, `--export=dir` there and `--import=dir` on the server, and copy `.data/ts/state/`.

Model files: `models/gw_mining_unet.onnx` and `models/gw_mining_unet.json`.

## 9. Results

See section "Results" below, filled from `research/smallmines/results/*.json` and `research/eval/*`.
