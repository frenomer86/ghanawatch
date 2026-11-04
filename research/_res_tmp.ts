(async () => {
  const { getDb, migrateDb, closeDb } = await import("@/lib/db/client");
  await migrateDb();
  const db = await getDb();
  const { reservoirsAdapter } = await import("@/pipeline/adapters/reservoirs");
  const fetchJson = async (u: string, init?: RequestInit) => { const r = await fetch(u, { ...init, signal: AbortSignal.timeout(300_000) }); if (!r.ok) throw new Error(`${r.status} ${u.slice(0, 80)}`); return r.json(); };
  const t = Date.now();
  const res = await reservoirsAdapter.run({ db, now: new Date(), log: console.log, fetchJson, fetchText: async () => "", env: {} } as never);
  console.log(res.extra, Math.round((Date.now() - t) / 1000), "s");
  const S = await import("@/lib/db/schema");
  const rows = await db.select().from(S.reservoirObservations).orderBy(S.reservoirObservations.slug, S.reservoirObservations.date);
  for (const r of rows) console.log(r.slug, r.date, r.orbit, r.waterKm2, r.waterPct, r.observedPct, r.thresholdDb, r.scenes);
  await closeDb();
})();
