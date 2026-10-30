"""Group SmallMinesDS patches into 10.24 km blocks (8 x 8 patches) for building GhanaWatch composites."""
import json
import numpy as np
from data import index


def main(year=2022):
    ps = [p for p in index() if p.year == year]
    xs = np.array([p.x0 for p in ps]); ys = np.array([p.y0 for p in ps])
    gx0, gy0 = xs.min(), ys.max()  # left edge of the westmost patch, top edge of the northmost
    blocks = {}
    for p in ps:
        c = int(round((p.x0 - gx0) / 1280)); r = int(round((gy0 - p.y0) / 1280))
        blocks.setdefault((c // 8, r // 8), []).append({"pid": p.pid, "col": c % 8, "row": r % 8, "split": p.split})
    out = []
    for (bc, br), pp in sorted(blocks.items()):
        minx = gx0 + bc * 8 * 1280; maxy = gy0 - br * 8 * 1280
        out.append({"id": f"b{bc}_{br}", "epsg": 32630, "bbox": [minx, maxy - 8 * 1280, minx + 8 * 1280, maxy], "res": 10, "patches": pp})
    json.dump(out, open(f"blocks_{year}.json", "w"))


if __name__ == "__main__":
    main()
