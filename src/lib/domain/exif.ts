/**
 * Where and when a photo was taken, from its EXIF block: GPS position, its stated accuracy, the time the shutter
 * fired, and the camera. Reads JPEG (APP1), WebP (EXIF chunk) and PNG (eXIf chunk). Pure and bounds-checked, so the
 * same code runs in the browser (to fill in the report form) and on the server (to check the report), and a
 * malformed or hostile file only ever yields null fields. The time is the camera's DateTimeOriginal, or failing
 * that the GPS fix's own UTC date and time.
 */
export interface PhotoMeta {
  lat: number | null;
  lon: number | null;
  /** Horizontal accuracy the phone reported (GPSHPositioningError), metres. */
  accuracyM: number | null;
  altitudeM: number | null;
  /** When the photo was taken, ISO 8601. With an offset when the camera recorded one, else read as GMT (Ghana). */
  takenAt: string | null;
  make: string | null;
  model: string | null;
}

const EMPTY: PhotoMeta = { lat: null, lon: null, accuracyM: null, altitudeM: null, takenAt: null, make: null, model: null };

export function readPhotoMeta(input: ArrayBuffer | Uint8Array): PhotoMeta {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    const tiff = findTiff(b);
    return tiff ? parseTiff(b, tiff.start, tiff.end) : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** The TIFF block holding EXIF inside a JPEG, WebP or PNG file. */
function findTiff(b: Uint8Array): { start: number; end: number } | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p] !== 0xff) return null;
      const marker = b[p + 1];
      if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no EXIF before the pixels
      const len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2 || p + 2 + len > b.length) return null;
      if (marker === 0xe1 && len >= 8 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
        return { start: p + 10, end: p + 2 + len };
      }
      p += 2 + len;
    }
    return null;
  }
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    let p = 12;
    while (p + 8 <= b.length) {
      const id = ascii(p, 4);
      const size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
      if (size < 0 || p + 8 + size > b.length) return null;
      if (id === "EXIF") {
        let s = p + 8;
        if (ascii(s, 6) === "Exif\0\0") s += 6; // some writers keep the JPEG prefix
        return { start: s, end: p + 8 + size };
      }
      p += 8 + size + (size & 1);
    }
    return null;
  }
  if (b[0] === 0x89 && ascii(1, 3) === "PNG") {
    let p = 8;
    while (p + 12 <= b.length) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const id = ascii(p + 4, 4);
      if (p + 12 + len > b.length) return null;
      if (id === "eXIf") return { start: p + 8, end: p + 8 + len };
      if (id === "IDAT" || id === "IEND") return null;
      p += 12 + len;
    }
  }
  return null;
}

function parseTiff(b: Uint8Array, start: number, end: number): PhotoMeta {
  const view = new DataView(b.buffer, b.byteOffset + start, end - start);
  const n = view.byteLength;
  if (n < 8) return { ...EMPTY };
  const le = view.getUint16(0) === 0x4949;
  if (!le && view.getUint16(0) !== 0x4d4d) return { ...EMPTY };
  const u16 = (o: number) => (o + 2 <= n ? view.getUint16(o, le) : 0);
  const u32 = (o: number) => (o + 4 <= n ? view.getUint32(o, le) : 0);
  if (u16(2) !== 42) return { ...EMPTY };
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  type Entry = { type: number; count: number; at: number };
  const readIfd = (off: number): Map<number, Entry> => {
    const out = new Map<number, Entry>();
    if (off < 8 || off + 2 > n) return out;
    const count = Math.min(u16(off), 512);
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > n) break;
      const type = u16(e + 2);
      const cnt = u32(e + 4);
      const bytes = (SIZE[type] ?? 0) * cnt;
      if (!bytes || bytes > 65536) continue;
      out.set(u16(e), { type, count: cnt, at: bytes <= 4 ? e + 8 : u32(e + 8) });
    }
    return out;
  };
  const inside = (e: Entry) => e.at + (SIZE[e.type] ?? 0) * e.count <= n;
  const str = (e?: Entry) => {
    if (!e || e.type !== 2 || !inside(e)) return null;
    let s = "";
    for (let i = 0; i < e.count; i++) {
      const c = view.getUint8(e.at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    s = s.trim();
    return s ? s.slice(0, 64) : null;
  };
  const rational = (e: Entry | undefined, i: number) => {
    if (!e || (e.type !== 5 && e.type !== 10) || i >= e.count || !inside(e)) return null;
    const o = e.at + i * 8;
    const num = e.type === 10 ? view.getInt32(o, le) : view.getUint32(o, le);
    const den = e.type === 10 ? view.getInt32(o + 4, le) : view.getUint32(o + 4, le);
    return den ? num / den : null;
  };
  const byte0 = (e?: Entry) => (e && inside(e) ? view.getUint8(e.at) : null);

  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0.get(0x8769);
  const gpsPtr = ifd0.get(0x8825);
  const exif = exifPtr && exifPtr.type === 4 ? readIfd(u32(exifPtr.at)) : new Map<number, Entry>();
  const gps = gpsPtr && gpsPtr.type === 4 ? readIfd(u32(gpsPtr.at)) : new Map<number, Entry>();

  const dms = (tag: number, refTag: number, neg: string) => {
    const e = gps.get(tag);
    const d = rational(e, 0), m = rational(e, 1), s = rational(e, 2);
    if (d == null || m == null || s == null) return null;
    const v = d + m / 60 + s / 3600;
    const ref = str(gps.get(refTag));
    return ref && ref.toUpperCase().startsWith(neg) ? -v : v;
  };
  let lat = dms(2, 1, "S");
  let lon = dms(4, 3, "W");
  // (0, 0) and out-of-range values are what phones write when they had no fix.
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
    lat = null;
    lon = null;
  }
  const alt = rational(gps.get(6), 0);
  const altRef = byte0(gps.get(5));
  const acc = rational(gps.get(0x1f), 0);

  const when = str(exif.get(0x9003)) ?? str(exif.get(0x9004)) ?? str(ifd0.get(0x0132));
  const offset = str(exif.get(0x9011)) ?? str(exif.get(0x9010));
  let takenAt: string | null = null;
  const m = when?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m && m[1] !== "0000") {
    const off = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "Z";
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
    if (!Number.isNaN(d.getTime())) takenAt = d.toISOString();
  }
  // Without a camera clock, the GPS fix carries its own UTC date and time.
  if (!takenAt) {
    const gd = str(gps.get(0x1d))?.match(/^(\d{4}):(\d{2}):(\d{2})/);
    const gt = gps.get(7);
    const hh = rational(gt, 0), mm = rational(gt, 1), ss = rational(gt, 2);
    if (gd && gd[1] !== "0000" && hh != null && mm != null && ss != null && hh < 24 && mm < 60 && ss < 61) {
      const d = new Date(Date.UTC(+gd[1], +gd[2] - 1, +gd[3], Math.floor(hh), Math.floor(mm), Math.floor(ss)));
      if (!Number.isNaN(d.getTime())) takenAt = d.toISOString();
    }
  }

  return {
    lat: lat == null ? null : Math.round(lat * 1e6) / 1e6,
    lon: lon == null ? null : Math.round(lon * 1e6) / 1e6,
    accuracyM: acc != null && acc >= 0 && acc < 1e5 ? Math.round(acc) : null,
    altitudeM: alt != null ? Math.round((altRef === 1 ? -alt : alt) * 10) / 10 : null,
    takenAt,
    make: str(ifd0.get(0x010f)),
    model: str(ifd0.get(0x0110)),
  };
}
