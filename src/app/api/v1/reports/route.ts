import { after, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { reportBody, PHOTO_MAX_BYTES, PHOTO_MIME } from "@/lib/domain/validation";
import { getDb } from "@/lib/db/client";
import { changeEvents, communityReports } from "@/lib/db/schema";
import { uuidv7 } from "@/lib/server/ids";
import { putObject } from "@/lib/server/storage";
import { districtContaining } from "@/lib/db/repo/boundaries";
import { addCaseEvent, saveSatelliteCheck } from "@/lib/db/repo/cases";
import { satelliteCheck } from "@/lib/server/reports/satellite-check";
import { readPhotoMeta } from "@/lib/domain/exif";
import { redactContacts } from "@/lib/domain/redact";
import { haversineKm } from "@/lib/geo";
import { and, eq, gte, sql } from "drizzle-orm";
import { assertSameOrigin, clientIpHash, enforceRateLimit, handle, HttpError, json, readBody } from "@/lib/server/http";

/**
 * POST /api/v1/reports (multipart/form-data)
 * photo (jpeg|png|webp ≤ 5 MB), lat, lon, accuracyM?, description (≤ 500), category?, changeEventId?
 *
 * Anonymous: no name or account is asked for. The photo is sniffed by magic
 * bytes; the GPS position, accuracy and time the camera wrote are read from the
 * original (kept privately, as evidence for the automatic check), and the photo
 * is then re-encoded with sharp (which drops all of its metadata), downscaled to
 * 2048 px and stored under a random key. Phone numbers, e-mail addresses and
 * links are taken out of the description. Reports start as "pending" with the
 * public case trail at "reported"; the report reviewer (src/pipeline/
 * review-reports.ts) screens the photo, blurs faces and publishes or rejects
 * the report on the evidence, usually within a minute. The satellite comparison
 * starts as soon as the response is sent.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "reports");

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) throw new HttpError(415, "Expected multipart/form-data");
  // The whole upload is read through a byte ceiling, so a chunked request cannot skip the size check.
  const raw = await readBody(req, PHOTO_MAX_BYTES + 64 * 1024);
  const form = await new Request(req.url, { method: "POST", headers: { "content-type": ct }, body: raw }).formData();
  const photo = form.get("photo");
  if (!(photo instanceof File)) throw new HttpError(400, "A photo is required");
  if (photo.size === 0) throw new HttpError(400, "The photo file is empty");
  if (photo.size > PHOTO_MAX_BYTES) throw new HttpError(413, "Photo larger than 5 MB");

  const fields = reportBody.safeParse({
    lat: form.get("lat"),
    lon: form.get("lon"),
    accuracyM: form.get("accuracyM") ?? undefined,
    description: form.get("description"),
    category: form.get("category") ?? undefined,
    changeEventId: form.get("changeEventId") ?? undefined,
    locationSource: form.get("locationSource") ?? undefined,
    observedAt: form.get("observedAt") ?? undefined,
  });
  if (!fields.success) throw new HttpError(400, "Invalid report", fields.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));

  const bytes = Buffer.from(await photo.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind || !(PHOTO_MIME as readonly string[]).includes(kind)) throw new HttpError(415, "Photo must be JPEG, PNG or WebP");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const db = await getDb();

  // Same photo at the same spot within 10 minutes is a double submit.
  const dup = await db
    .select({ id: communityReports.id })
    .from(communityReports)
    .where(and(eq(communityReports.photoSha256, sha256), gte(communityReports.createdAt, new Date(Date.now() - 10 * 60_000))))
    .limit(1);
  if (dup.length) return json({ id: dup[0].id, status: "pending", duplicate: true }, { status: 200 });

  // A report may point at a detection; the detection must exist before anything is stored.
  if (fields.data.changeEventId) {
    const [ev] = await db.select({ id: changeEvents.id }).from(changeEvents).where(eq(changeEvents.id, fields.data.changeEventId)).limit(1);
    if (!ev) throw new HttpError(400, "Invalid report", [{ path: "changeEventId", message: "No such detection" }]);
  }

  // The camera's own record of where and when, read before re-encoding removes it.
  const meta = readPhotoMeta(bytes);
  const photoMeta = meta.lat != null || meta.takenAt ? { lat: meta.lat, lon: meta.lon, accuracyM: meta.accuracyM, takenAt: meta.takenAt } : null;
  const photoAt =
    meta.lat != null && meta.lon != null ? haversineKm({ lon: fields.data.lon, lat: fields.data.lat }, { lon: meta.lon, lat: meta.lat }) * 1000 : Infinity;
  const locationSource = photoAt <= 30 ? "photo" : (fields.data.locationSource ?? "pin");
  // A report that waited offline keeps the time it was made, within the last 30 days and not in the future.
  const now = Date.now();
  const observed = fields.data.observedAt ? Date.parse(fields.data.observedAt) : NaN;
  const observedAt = Number.isFinite(observed) && observed <= now + 5 * 60_000 && observed >= now - 30 * 86_400_000 ? new Date(Math.min(observed, now)) : null;
  const description = redactContacts(fields.data.description).text.slice(0, 500);

  const sharp = (await import("sharp")).default;
  const processed = await sharp(bytes, { failOn: "error", limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const id = uuidv7();
  const stored = await putObject(`reports/${id.slice(0, 4)}/${id}.webp`, processed, "image/webp");
  const key = stored.url ?? stored.key;

  const district = await districtContaining(fields.data.lon, fields.data.lat).catch(() => null);
  await db.insert(communityReports).values({
    id,
    lat: fields.data.lat,
    lon: fields.data.lon,
    accuracyM: fields.data.accuracyM ?? null,
    description,
    category: fields.data.category,
    locationSource,
    observedAt,
    photoMeta,
    photoKey: key,
    photoSha256: sha256,
    changeEventId: fields.data.changeEventId ?? null,
    districtId: district?.id ?? null,
    status: "pending",
    caseStatus: "reported",
    submittedIpHash: clientIpHash(req),
  });
  await addCaseEvent(id, { caseStatus: "reported", actorId: null });

  // Compare with the satellite record after the reporter has their answer.
  const { lon, lat, category } = fields.data;
  after(async () => {
    try {
      await saveSatelliteCheck(id, await satelliteCheck(lon, lat, category));
    } catch (e) {
      console.error("[reports] satellite check failed", id, e instanceof Error ? e.message : e);
    }
  });

  return json({ id, status: "pending" }, { status: 201 });
});

/** GET returns only aggregate counts; individual reports are visible to moderators. */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const db = await getDb();
  const rows = await db
    .select({ status: communityReports.status, n: sql<number>`count(*)::int` })
    .from(communityReports)
    .groupBy(communityReports.status);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = Number(r.n);
  return json({ counts }, { cache: "short" });
});

function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}
