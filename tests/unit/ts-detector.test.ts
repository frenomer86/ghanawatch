import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChannels, CHANNELS, N_CH, normalise, terrain } from "@/pipeline/ts/features";
import { compositeObservations, HLS_MSI_TO_OLI, landsatClear, median, monthRange } from "@/pipeline/ts/composite";
import { decodeState, encodeState, monthIndex, monthName, newState, REGIME, status, step, DEFAULT_PARAMS } from "@/pipeline/ts/tracker";
import { extractSites, siteHull } from "@/pipeline/ts/sites";
import { tiledPredict, tileStarts } from "@/pipeline/ts/model";
import { cellLayout, poolToState } from "@/pipeline/ts/cell";
import { blockGrid } from "@/pipeline/ts/cog";
import { toHalf } from "@/pipeline/ts/npy";

describe("model input channels match the Python reference (features.py)", () => {
  const fx = JSON.parse(readFileSync(join(__dirname, "../fixtures/features-parity.json"), "utf8"));
  const { H, W } = fx;
  const n = H * W;
  const flat = (a: number[][]) => Float32Array.from(a.flat().map((v) => (v === -999 ? Number.NaN : v)));
  const refl = (fx.refl as number[][][]).map(flat);
  const comp = { refl, optOk: Uint8Array.from((fx.opt as number[][]).flat()), reOk: Uint8Array.from((fx.re as number[][]).flat()), vv: flat(fx.vv), vh: flat(fx.vh) };
  const t = terrain(Float32Array.from((fx.dem as number[][]).flat()), W, H, fx.res);
  const ch = buildChannels(comp, t, n);

  it("has the same channel list", () => {
    expect(N_CH).toBe(24);
    expect(CHANNELS[0]).toBe("B02");
    expect(CHANNELS[23]).toBe("RE_OK");
  });

  it("computes every channel the same, apart from red-edge values the model never sees", () => {
    for (let k = 0; k < N_CH; k++) {
      const ref = (fx.channels[k] as number[][]).flat();
      for (let i = 0; i < n; i++) {
        if ([3, 4, 5, 16].includes(k) && !comp.reOk[i]) continue;
        expect(ch[k][i]).toBeCloseTo(ref[i], 4);
      }
    }
  });

  it("normalises the same way, hiding unobserved optical, red-edge and radar values", () => {
    normalise(ch, { mean: fx.mean, std: fx.std });
    for (let k = 0; k < N_CH; k++) {
      const ref = (fx.normalised[k] as number[][]).flat();
      for (let i = 0; i < n; i++) expect(ch[k][i]).toBeCloseTo(ref[i], 3);
    }
  });
});

describe("monthly composite", () => {
  const mk = (date: string, vals: number[], ok = 1) => ({ date, bands: vals.map((v) => Float32Array.from([v])), ok: Uint8Array.from([ok]) });
  const clear = [0.03, 0.06, 0.04, 0.09, 0.2, 0.25, 0.3, 0.31, 0.18, 0.09];

  it("takes the per-band median of clear observations", () => {
    const r = compositeObservations([mk("2022-01-01", clear), mk("2022-01-06", clear.map((v) => v + 0.01)), mk("2022-01-11", clear.map((v) => v + 0.02))], 1, 10);
    expect(r.count[0]).toBe(3);
    expect(r.refl[0][0]).toBeCloseTo(0.04, 5);
  });

  it("drops a hazy pass and an unflagged cloud shadow that stand out from the month", () => {
    const haze = clear.map((v, b) => (b === 0 ? 0.11 : v));
    const shadow = clear.map((v, b) => (b === 6 || b === 8 ? v * 0.3 : v));
    const r = compositeObservations([mk("2022-01-01", clear), mk("2022-01-06", clear), mk("2022-01-11", haze), mk("2022-01-16", shadow)], 1, 10);
    expect(r.count[0]).toBe(2);
    expect(r.refl[0][0]).toBeCloseTo(0.03, 5);
    expect(r.refl[6][0]).toBeCloseTo(0.3, 5);
  });

  it("counts one pass once where two tiles overlap", () => {
    const r = compositeObservations([mk("2022-01-01", clear), mk("2022-01-01", clear)], 1, 10);
    expect(r.count[0]).toBe(1);
  });

  it("leaves a pixel empty when no pass saw it", () => {
    const r = compositeObservations([mk("2022-01-01", clear, 0)], 1, 10);
    expect(r.count[0]).toBe(0);
    expect(Number.isNaN(r.refl[0][0])).toBe(true);
  });

  it("reads Landsat QA_PIXEL: clear or water kept, cloud, shadow, cirrus and fill dropped", () => {
    expect(landsatClear(1 << 6)).toBe(true);
    expect(landsatClear(1 << 7)).toBe(true);
    expect(landsatClear((1 << 6) | (1 << 3))).toBe(false);
    expect(landsatClear((1 << 6) | (1 << 4))).toBe(false);
    expect(landsatClear(1)).toBe(false);
    expect(landsatClear(0)).toBe(false);
  });

  it("puts Landsat on the Sentinel-2 scale with the inverse HLS adjustment", () => {
    const { slope, offset } = HLS_MSI_TO_OLI[0];
    const msi = 0.05;
    const oli = slope * msi + offset;
    expect((oli - offset) / slope).toBeCloseTo(msi, 9);
  });

  it("knows month boundaries", () => {
    const [a, b] = monthRange("2022-12");
    expect(a.toISOString()).toBe("2022-12-01T00:00:00.000Z");
    expect(b.toISOString()).toBe("2023-01-01T00:00:00.000Z");
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe("temporal tracker", () => {
  const run = (probs: number[], regime: number = REGIME.sentinel2) => {
    const s = newState(1);
    probs.forEach((p, t) => step(s, monthIndex("2019-01") + t, Float32Array.from([p]), Uint8Array.from([Number.isNaN(p) ? 0 : regime])));
    return s;
  };

  it("dates mining to the first month of the run that confirmed it", () => {
    const s = run([0.05, 0.05, 0.05, 0.9, 0.9, 0.9, 0.9, 0.9]);
    expect(status(s)[0]).toBe(1);
    expect(monthName(s.onset[0])).toBe("2019-04");
  });

  it("ignores a single mining-looking month (haze, shadow, a ploughed field)", () => {
    const s = run([0.05, 0.05, 0.95, 0.05, 0.05, 0.05]);
    expect(status(s)[0]).toBe(0);
    expect(s.onset[0]).toBe(-1);
  });

  it("carries the evidence across cloudy months with no observation", () => {
    const s = run([0.9, Number.NaN, Number.NaN, 0.9, 0.9, 0.9]);
    expect(monthName(s.onset[0])).toBe("2019-01");
  });

  it("needs more radar-only months than optical months to confirm", () => {
    const months = (regime: number) => {
      const s = newState(1);
      for (let t = 0; t < 24; t++) {
        step(s, t, Float32Array.from([0.85]), Uint8Array.from([regime]));
        if (s.onset[0] >= 0) return t + 1;
      }
      return 99;
    };
    expect(months(REGIME.radar)).toBeGreaterThan(months(REGIME.sentinel2));
  });

  it("marks a site that turned green again as regrown, keeping its onset", () => {
    const s = run([...Array(6).fill(0.95), ...Array(30).fill(0.03)]);
    expect(status(s)[0]).toBe(2);
    expect(s.p2[0]).toBeGreaterThan(s.p1[0]);
    expect(monthName(s.onset[0])).toBe("2019-01");
  });

  it("refuses to process a month twice and survives a save and reload", () => {
    const s = run([0.9, 0.9, 0.9]);
    expect(() => step(s, s.lastMonth, Float32Array.from([0.5]), Uint8Array.from([1]))).toThrow();
    const back = decodeState(encodeState(s));
    expect(back.onset[0]).toBe(s.onset[0]);
    expect(back.p1[0]).toBeCloseTo(s.p1[0], 6);
    expect(back.lastMonth).toBe(s.lastMonth);
  });

  it("never moves an onset once set", () => {
    const s = run([0.9, 0.9, 0.9, 0.9, 0.05, 0.05, 0.9, 0.9, 0.9]);
    expect(monthName(s.onset[0])).toBe("2019-01");
  });

  it("uses month indexes that round-trip", () => {
    expect(monthName(monthIndex("2026-10"))).toBe("2026-10");
    expect(DEFAULT_PARAMS.threshold).toBe(0.5);
  });
});

describe("sites from the tracker", () => {
  it("groups mined pixels, dates them and reports area added this month", () => {
    const W = 10, H = 6;
    const s = newState(W * H);
    // Site A (9 px) mined from month 0; site B (2 px, below the minimum area) mined from month 1.
    const a = [11, 12, 13, 21, 22, 23, 31, 32, 33];
    const b = [18, 19];
    for (let t = 0; t < 6; t++) {
      const before = Int16Array.from(s.onset);
      const p = new Float32Array(W * H).fill(0.02);
      for (const i of a) p[i] = 0.95;
      if (t >= 1) for (const i of b) p[i] = 0.95;
      step(s, t, p, new Uint8Array(W * H).fill(1));
      const sites = extractSites(s, W, H, 20, before);
      if (t === 5) {
        expect(sites).toHaveLength(1);
        expect(sites[0].areaHa).toBeCloseTo(0.36, 2);
        expect(sites[0].onset).toBe(monthName(0));
        expect(sites[0].newlyConfirmedHa).toBe(0);
      }
    }
  });

  it("draws a closed outline", () => {
    const ring = siteHull([0, 1, 10, 11], 10, [0, 0, 200, 200], 20);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBe(5);
  });
});

describe("model tiling and pooling", () => {
  it("covers the grid with overlapping tiles flush with the edges", () => {
    expect(tileStarts(100, 128, 96)).toEqual([0]);
    expect(tileStarts(300, 128, 96)).toEqual([0, 96, 172]);
  });

  it("blends tiles without seams (a model that echoes its input gives the input back)", async () => {
    const w = 300, h = 200;
    const ch = Array.from({ length: N_CH }, () => new Float32Array(w * h));
    for (let i = 0; i < w * h; i++) ch[0][i] = (i % 97) / 97;
    const out = await tiledPredict(ch, w, h, 128, 96, async (batch, n, ph, pw) => {
      const o = new Float32Array(n * ph * pw);
      for (let b = 0; b < n; b++) o.set(batch.subarray(b * N_CH * ph * pw, b * N_CH * ph * pw + ph * pw), b * ph * pw);
      return o;
    });
    for (let i = 0; i < w * h; i++) expect(out[i]).toBeCloseTo(ch[0][i], 5);
  });

  it("pools 10 m probabilities to the 20 m tracker grid, keeping the best regime", () => {
    const g = blockGrid(32630, [0, 0, 40, 40], 10);
    const prob = Float32Array.from([0.2, 0.4, 0.9, 0.9, 0.6, 0.8, 0.9, 0.9, 0, 0, 0, 0, 0, 0, 0, 0]);
    const regime = Uint8Array.from([1, 3, 3, 3, 1, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = { prob: new Float32Array(4), regime: new Uint8Array(4), width: 2 };
    poolToState(prob, regime, g, 2, out, 0, 0);
    expect(out.prob[0]).toBeCloseTo(0.5, 5);
    expect(out.regime[0]).toBe(1);
    expect(out.regime[1]).toBe(3);
    expect(out.regime[2]).toBe(0);
    expect(Number.isNaN(out.prob[2])).toBe(true);
  });

  it("lays a gold-belt cell out at 10 m in blocks that tile the 20 m tracker grid", () => {
    const L = cellLayout({ id: "c1_1", regionName: "Western Region", minLon: -2.2, minLat: 5.2, maxLon: -2.0, maxLat: 5.4, priority: 2 });
    expect(L.res).toBe(10);
    let px = 0;
    for (const b of L.blocks) px += (b.grid.width / 2) * (b.grid.height / 2);
    expect(px).toBe(L.state.width * L.state.height);
    const north = cellLayout({ id: "c9_30", regionName: "Northern Region", minLon: -1, minLat: 9.6, maxLon: -0.8, maxLat: 9.8, priority: 1 });
    expect(north.res).toBe(20);
  });
});

describe("half-precision files", () => {
  it("converts to IEEE half precision", () => {
    expect(toHalf(0)).toBe(0);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
  });
});

describe("Sentinel-2 reflectance offset", () => {
  it("does not subtract the baseline-04.00 offset twice when Earth Search has already applied it", async () => {
    const { s2Offset } = await import("@/pipeline/ts/catalog");
    expect(s2Offset({ "s2:processing_baseline": "04.00", "earthsearch:boa_offset_applied": true }, -0.1)).toBe(0);
    expect(s2Offset({ "s2:processing_baseline": "04.00", "earthsearch:boa_offset_applied": false }, -0.1)).toBe(-0.1);
    expect(s2Offset({ "s2:processing_baseline": "03.01" }, 0)).toBe(0);
  });
});
