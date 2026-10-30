import type { LandSummary } from "@/lib/domain/land";
import { dmy } from "@/lib/domain/land-findings";
import { TtlCache } from "@/lib/server/explore/cache";
import { plotImage, type ImageLayer } from "./images";
import { plotKey } from "./check";
import type { Plot } from "./plot";

/** The three pictures of a land report, each with the caption that dates and credits it. */
export type ReportLayer = "before" | "after" | "closeup";

const cache = new TtlCache<Buffer>(300, 24 * 3_600_000);

export function layerFor(s: LandSummary, which: ReportLayer): { layer: ImageLayer; caption: string } | null {
  if (which === "closeup") {
    if (!s.closeUp) return null;
    const what = [s.closeUp.provider, s.closeUp.sensor, s.closeUp.resolutionM ? `${s.closeUp.resolutionM} m` : null].filter(Boolean).join(" ");
    return {
      layer: { kind: "closeup", release: s.closeUp.release },
      caption: `Close-up${s.closeUp.capturedOn ? `, captured ${dmy(s.closeUp.capturedOn)}` : ""}${what ? ` (${what})` : ""}. Esri World Imagery.`,
    };
  }
  if (!s.mosaicYears) return null;
  const year = which === "before" ? s.mosaicYears.first : s.mosaicYears.latest;
  return { layer: { kind: "mosaic", year }, caption: `${year}: cloud-free Sentinel-2 view of the year, 10 m. Sentinel-2 cloudless by EOX.` };
}

export async function reportImage(plot: Plot, s: LandSummary, which: ReportLayer): Promise<{ jpeg: Buffer; caption: string } | null> {
  const l = layerFor(s, which);
  if (!l) return null;
  const jpeg = await cache.get(`${plotKey(plot)}:${which}:${l.layer.kind === "mosaic" ? l.layer.year : l.layer.release}`, () => plotImage(plot, l.layer));
  return { jpeg, caption: l.caption };
}
