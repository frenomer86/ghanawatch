# New tracks into forest reserves

A new track cut into a forest reserve is usually the first visible step of an incursion: pits, camps and log
landings follow along it. GhanaWatch reports such tracks as "new road" detections (`properties.signature =
new_road`), names the reserve each one enters or approaches, and lists them on district and reserve pages.

## Why a dedicated scan

GhanaWatch's national Sentinel-2 scans run at 20 m (priority regions) and 40 m (elsewhere). A track 5 to 15 m wide
is a fraction of such a pixel and does not register. We first tested whether Global Forest Watch's integrated
alerts, which are at 10 m, keep tracks as lines. Over the 49 cells with most recent alerts (1,583 alert tiles at
zoom 14, the last 120 days), only six alert patches were long and narrow enough to be a track, and all six lay
along the edge of an older clearing: they were the growing rim of a pit, not a new line into forest. The alert
layer is therefore kept as a secondary source (`src/pipeline/adapters/gfw-alerts.ts`), and the main source is a
scan at Sentinel-2's full 10 m resolution (`src/pipeline/adapters/forest-tracks.ts`).

## Where and how often

Scanning all of southern Ghana at 10 m every month would cost tens of gigabytes per pass. The scan covers the
forest reserves and other protected areas (OpenStreetMap outlines) and a band of 2 km around them, cut into boxes
of 0.1 degree. Each box is scanned again after 30 days; a run stops after `GW_TRACKS_BUDGET_MINUTES` (45) and
continues from the oldest boxes the next day. On the test machine a box took 16 to 31 seconds to read.

## Detection (`src/pipeline/tracks/detect.ts`, `shape.ts`)

For each box, the clearest scenes of the last 120 days (up to seven) are compared with the clearest scenes one to
two years earlier (up to eight). Pixels are screened with the scene classification and a haze test, as in the
national scan. A pixel has newly opened when

- its median NDVI in the baseline was at least 0.6 (closed vegetation);
- its recent median NDVI is at most 0.5 and at least 0.2 below the baseline;
- soil showed (SWIR at least 0.12, bare-soil index at least -0.05) in at least two clear recent observations and in
  at least half of them, so a cloud edge or shadow that the scene mask missed once does not count;
- its recent median is not water.

A track mixes laterite with the canopy at its verges, which is why the thresholds are looser than the bare-ground
rule of the pit detector. Tracks usually end at a clearing and join it; where a 5-by-5-pixel square fits wholly
inside the opened area is taken as the body of a clearing and set aside, with a margin, before grouping. Opened
pixels up to one pixel apart are grouped, so a crown over the track does not split it. A group is a track when

- it is at least 250 m long, at most 35 m wide and at least eight times longer than wide (length along its
  principal axis, measured on a centre line through groups of four pixels; width as area over length);
- at most a quarter of its pixels lie within two pixels of ground that was already open in the baseline (a strip
  along an older clearing is that clearing growing);
- at most 15 % of its pixels lie within two pixels of water seen recently (a line of water-filled pits up a stream
  is left to the pit detectors).

Confidence is high when its pixels showed soil on three or more clear recent views on average, medium otherwise.

## Placing a track (`src/pipeline/context/roads.ts`)

After each pipeline run, every track first seen in the last year is placed against the protected areas and the
mining GhanaWatch has found: inside a reserve with mining within 2 km is urgent; inside a reserve, elevated;
within 1 km of a reserve's edge, watch; elsewhere, normal. The title names the reserve.

## Checks so far

The scan was run on two 10-by-10 km boxes and every detection was checked by eye against true-colour Sentinel-2
imagery from before and after.

- Atewa hills (6.15 N, 0.55 W): four detections. Two are plainly new tracks absent in February 2025 and present in
  October 2026, the longer a winding track of about 950 m between two new mining areas; one is a new strip through
  ground that was mined all around in the same period; one, at the edge of a settlement, could not be told apart
  from a new street.
- Mining belt near 6.15 N, 1.88 W: eight detections. At least four are new linear cuts into forest (a track north
  from a large pit, strips running from pits into forest); the rest could not be judged because the review images
  were hazy.

Run through the pipeline on four boxes around Atewa with a test outline in place of a reserve, the scan stored 19
detections, each with a before and an after image; the 970 m winding track fell inside the outline and was raised
to elevated with the outline's name in its title. This is a small check, not an accuracy estimate; a random sample
with ground or high-resolution checks should follow before the figures are quoted.

## Limits

- Tracks under intact canopy, or narrower than about 5 m, do not show at 10 m.
- In the rainy season few clear views reach some boxes; those boxes report nothing until clearer scenes arrive.
- A line of clearing for pits along a dry valley has the same shape as a track and is reported as one.
- Reserve outlines come from OpenStreetMap and may differ from the gazetted boundaries.
