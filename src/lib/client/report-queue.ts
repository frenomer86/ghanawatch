"use client";

/**
 * Offline queue for community reports, in IndexedDB (photos are Blobs, which
 * localStorage cannot hold). flushQueue() posts anything pending; it is called
 * on load and on the `online` event. The original photo file is kept as it is,
 * so the server can still read the location the camera saved in it.
 */
const DB = "gw-reports";
const STORE = "queue";

interface QueuedReport {
  id?: number;
  photo: Blob;
  lat: string;
  lon: string;
  accuracyM: number | null;
  description: string;
  /** Missing on reports queued before categories existed. */
  category?: string;
  /** Where the position came from (missing on reports queued before the automatic check). */
  locationSource?: string;
  queuedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueReport(r: Omit<QueuedReport, "id" | "queuedAt">) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ ...r, queuedAt: new Date().toISOString() } satisfies QueuedReport);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function flushQueue(): Promise<number> {
  if (typeof indexedDB === "undefined" || !navigator.onLine) return 0;
  const db = await openDb();
  const items = await new Promise<QueuedReport[]>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedReport[]);
    req.onerror = () => reject(req.error);
  });
  let sent = 0;
  for (const item of items) {
    const fd = new FormData();
    fd.set("photo", item.photo, "photo.jpg");
    fd.set("lat", item.lat);
    fd.set("lon", item.lon);
    if (item.accuracyM != null) fd.set("accuracyM", String(item.accuracyM));
    fd.set("description", item.description);
    if (item.category) fd.set("category", item.category);
    if (item.locationSource) fd.set("locationSource", item.locationSource);
    // When the report was made, so the photo's age is measured from then, not from when the phone got signal.
    fd.set("observedAt", item.queuedAt);
    try {
      const res = await fetch("/api/v1/reports", { method: "POST", body: fd });
      // 4xx means the report itself is invalid; drop it rather than retry forever.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(item.id!);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        if (res.ok) sent++;
      }
    } catch {
      break; // still offline
    }
  }
  return sent;
}
