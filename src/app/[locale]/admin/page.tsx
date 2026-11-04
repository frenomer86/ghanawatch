import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { currentUser } from "@/lib/server/auth";
import { getDb } from "@/lib/db/client";
import { changeEvents, communityReports, dataSources, newsSignals, pipelineRuns } from "@/lib/db/schema";
import { AutoDecisions, ModerationQueue } from "@/components/admin/moderation-queue";
import type { AutoReview } from "@/lib/domain/auto-review";
import { SightingQueue } from "@/components/admin/sighting-queue";
import { pendingSightings } from "@/lib/db/repo/sightings";
import { openCases } from "@/lib/db/repo/cases";
import { CaseActions } from "@/components/admin/case-actions";
import type { SatelliteCheck } from "@/lib/domain/cases";
import { LogoutButton } from "@/components/admin/logout-button";
import { TwoFactorSetup } from "@/components/admin/two-factor-setup";
import { PasswordChange } from "@/components/admin/password-change";
import { AccuracyCheckForm, CorrectionForm, IntakeForm, SampleQueue, type SampleItem } from "@/components/admin/index-tools";
import { rows as toRows } from "@/lib/db/client";

export const metadata: Metadata = { title: "Administration", robots: { index: false } };
// Session check needs cookies before anything renders; this route is never prerendered.
export const instant = false;

/**
 * Admin home (FR-17, FR-18): pipeline health per source, the moderation
 * queue, and the newest unreviewed detections. Server-rendered behind the
 * session check; mutations go through /api/v1/admin/*.
 */
export default async function AdminPage({ params }: PageProps<"/[locale]/admin">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  await connection();
  const user = await currentUser();
  if (!user || (user.role !== "admin" && user.role !== "moderator")) redirect(`/${locale === "en" ? "" : `${locale}/`}admin/login`);

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">Administration</h1>
            <p className="text-sm text-muted-foreground">
              Signed in as {user.displayName} ({user.role}).
            </p>
          </div>
          <LogoutButton />
        </div>
        {user.mustChangePassword && <PasswordChange required />}
        {!user.twoFactor && <TwoFactorSetup />}
        {!user.mustChangePassword && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Change password</summary>
            <PasswordChange required={false} />
          </details>
        )}
        <Suspense fallback={null}>
          <AdminBody full={user.twoFactor && !user.mustChangePassword} />
        </Suspense>
      </div>
    </AppShell>
  );
}

/** `full` is false until the account has two-step sign-in on and its own password: then only the dashboards show, not the queues of pending reports. */
async function AdminBody({ full }: { full: boolean }) {
  await connection();
  const db = await getDb();
  const runs = await db
    .select({
      source: dataSources.name,
      slug: dataSources.slug,
      status: pipelineRuns.status,
      startedAt: pipelineRuns.startedAt,
      finishedAt: pipelineRuns.finishedAt,
      inserted: pipelineRuns.inserted,
      error: pipelineRuns.error,
    })
    .from(pipelineRuns)
    .innerJoin(dataSources, eq(dataSources.id, pipelineRuns.sourceId))
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(12);
  const pending = full ? await db.select().from(communityReports).where(eq(communityReports.status, "pending")).orderBy(desc(communityReports.createdAt)).limit(50) : [];
  // What the report reviewer decided on its own in the last week, for a moderator to overturn if it erred.
  const autoDecided = full
    ? await db
        .select()
        .from(communityReports)
        .where(
          and(
            isNotNull(communityReports.autoReview),
            isNull(communityReports.moderatorId),
            inArray(communityReports.status, ["approved", "rejected", "unverified"]),
            sql`${communityReports.moderatedAt} >= now() - interval '7 days'`,
          ),
        )
        .orderBy(desc(communityReports.moderatedAt))
        .limit(30)
    : [];
  const sightings = full ? await pendingSightings(50) : [];
  // Open cases carry the reporter's exact spot, and news signals are staff-only working material: like the
  // queues, they wait until the account has two-step sign-in on, so a stolen password alone shows no more
  // than the public site does.
  const cases = full ? await openCases(50) : [];
  const [counts] = await db
    .select({
      newEvents: sql<number>`count(*) filter (where status = 'new')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(changeEvents);
  // Background signals from public news and disaster feeds; staff only, never on public pages.
  const signals = full ? await db.select().from(newsSignals).orderBy(desc(sql`coalesce(${newsSignals.publishedAt}, ${newsSignals.createdAt})`)).limit(40) : [];
  const unreviewed = await db
    .select({ id: changeEvents.id, title: changeEvents.titleEn, severity: changeEvents.severity, detectedAt: changeEvents.detectedAt, updatedAt: changeEvents.updatedAt })
    .from(changeEvents)
    .where(eq(changeEvents.status, "new"))
    .orderBy(desc(changeEvents.detectedAt))
    .limit(20);

  // The index's credibility tools: the open confirmation sample (newest month first), checks, corrections, intakes.
  const sample = toRows<{ id: string; month: string; event_id: string; title: string; ha: number; lat: number; lon: number; image_date: string | null; verdict: string | null }>(
    await db.execute(sql`
      select s.id::text, s.month, e.id::text as event_id, e.title_en as title, coalesce(e.area_ha, 0)::float ha, e.centroid_lat::float lat, e.centroid_lon::float lon,
        e.image_date::text as image_date, s.verdict
      from confirmation_samples s join change_events e on e.id = s.change_event_id
      where s.month = (select max(month) from confirmation_samples)
      order by s.verdict nulls first, e.area_ha desc nulls last`),
  );
  const sampleItems: SampleItem[] = sample.map((r) => ({ id: r.id, month: r.month, eventId: r.event_id, title: r.title, areaHa: Number(r.ha), lat: Number(r.lat), lon: Number(r.lon), imageDate: r.image_date, verdict: r.verdict }));
  const [closed] = toRows<{ latest: string | null; n: number }>(await db.execute(sql`select max(month) as latest, count(*)::int n from national_months`));
  const [released] = toRows<{ latest: string | null }>(await db.execute(sql`select max(month) as latest from releases where not dry_run`));

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-2">
      <section aria-labelledby="h-index" className="rounded-xl border bg-card p-5 lg:col-span-2">
        <h2 id="h-index" className="text-lg font-semibold">
          The Galamsey Index
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {closed?.n ? `${closed.n} months closed, latest ${closed.latest}.` : "No month closed yet."} {released?.latest ? `Latest release: ${released.latest}.` : "Nothing released yet."} Close a month
          with <code>npm run index:close</code>, release it with <code>npm run release</code>; the scheduler does both on the first Monday of the month.
        </p>
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="font-medium">Confirmation sample</h3>
            <SampleQueue items={sampleItems} />
          </div>
          <div>
            <h3 className="font-medium">Record an accuracy check</h3>
            <AccuracyCheckForm />
            <h3 className="mt-6 font-medium">Publish a correction</h3>
            <CorrectionForm />
            <h3 className="mt-6 font-medium">Add a drinking-water intake</h3>
            <IntakeForm />
          </div>
        </div>
      </section>
      <section aria-labelledby="h-signals" className="rounded-xl border bg-card p-5 lg:col-span-2">
        <h2 id="h-signals" className="text-lg font-semibold">
          News signals
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Stories from public news and disaster feeds that name a place and an event. A placed galamsey or flood story queues a satellite re-check
          of the area and can back up a detection already there. Staff only: nothing here is shown on the public site.
        </p>
        {signals.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{full ? "No signals yet." : "Shown once two-step sign-in is on."}</p>
        ) : (
          <div className="mt-3 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Pipeline runs">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Date</th>
                  <th className="py-1.5 pr-3 font-medium">Event</th>
                  <th className="py-1.5 pr-3 font-medium">Place</th>
                  <th className="py-1.5 pr-3 font-medium">Story</th>
                  <th className="py-1.5 font-medium">Triggered</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((g) => {
                  const cells = Array.isArray(g.triggered.recheckCells) ? (g.triggered.recheckCells as string[]).length : 0;
                  return (
                    <tr key={g.id} className="border-t align-top">
                      <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums">{(g.publishedAt ?? g.createdAt).toISOString().slice(0, 10)}</td>
                      <td className="py-1.5 pr-3">{g.eventType.replace("_", " ")}</td>
                      <td className="py-1.5 pr-3">{g.placeName ?? <span className="text-muted-foreground">not placed</span>}</td>
                      <td className="py-1.5 pr-3">
                        <a href={g.url} target="_blank" rel="noopener noreferrer" className="text-link underline">
                          {g.title}
                        </a>
                        <span className="block text-xs text-muted-foreground">{g.source}</span>
                      </td>
                      <td className="py-1.5 text-xs text-muted-foreground">
                        {cells ? `re-check of ${cells} scan area${cells === 1 ? "" : "s"} queued` : g.placeName ? "recorded" : "nothing (no place)"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="h-pipeline" className="rounded-xl border bg-card p-5">
        <h2 id="h-pipeline" className="text-lg font-semibold">
          Pipeline runs
        </h2>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1.5 font-medium">Source</th>
              <th className="py-1.5 font-medium">Status</th>
              <th className="py-1.5 font-medium">Finished</th>
              <th className="py-1.5 text-right font-medium">Rows</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="py-1.5">{r.source}</td>
                <td className="py-1.5">
                  <span
                    className={
                      r.status === "ok"
                        ? "text-sev-normal"
                        : r.status === "failed"
                          ? "text-sev-urgent"
                          : r.status === "partial"
                            ? "text-sev-watch"
                            : "text-muted-foreground"
                    }
                  >
                    {r.status}
                  </span>
                  {r.error ? <span className="block text-xs text-muted-foreground">{r.error.slice(0, 80)}</span> : null}
                </td>
                <td className="py-1.5 tabular-nums">{r.finishedAt ? r.finishedAt.toISOString().slice(0, 16).replace("T", " ") : "running"}</td>
                <td className="py-1.5 text-right tabular-nums">{r.inserted}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-muted-foreground">
                  No runs yet. Run <code>npm run pipeline</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted-foreground">
          {counts?.newEvents ?? 0} of {counts?.total ?? 0} detections are unreviewed.
        </p>
      </section>

      <section aria-labelledby="h-queue" className="rounded-xl border bg-card p-5">
        <h2 id="h-queue" className="text-lg font-semibold">
          Reports waiting for evidence ({pending.length})
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The report reviewer publishes or rejects each report on its own within a minute; these have nothing to confirm them yet and are checked again with each satellite pass for 30 days. You can decide any of them yourself.
        </p>
        <ModerationQueue
          items={pending.map((p) => ({
            id: p.id,
            lat: p.lat,
            lon: p.lon,
            description: p.description,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
            photoKey: p.photoKey,
            category: p.category,
            satelliteCheck: (p.satelliteCheck as unknown as SatelliteCheck | null) ?? null,
            autoReview: (p.autoReview as unknown as AutoReview | null) ?? null,
          }))}
        />
        <h3 className="mt-6 text-sm font-semibold">Decided automatically this week ({autoDecided.length})</h3>
        <AutoDecisions
          items={autoDecided.map((p) => ({
            id: p.id,
            status: p.status,
            category: p.category,
            description: p.description,
            note: p.moderationNote,
            moderatedAt: (p.moderatedAt ?? p.updatedAt).toISOString(),
            updatedAt: p.updatedAt.toISOString(),
            photoKey: p.photoKey,
            autoReview: (p.autoReview as unknown as AutoReview | null) ?? null,
          }))}
        />
      </section>

      <section aria-labelledby="h-cases" className="rounded-xl border bg-card p-5 lg:col-span-2">
        <h2 id="h-cases" className="text-lg font-semibold">
          Open cases ({cases.length})
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Approved reports. Record when a case is passed to an authority and when action is seen; each step and its note appear on the public case page.
        </p>
        <CaseActions items={cases.map((c) => ({ id: c.id, category: c.category, caseStatus: c.caseStatus, authority: c.authority, district: c.districtName, createdAt: c.createdAt, lat: c.lat, lon: c.lon }))} />
      </section>

      <section aria-labelledby="h-sightings" className="rounded-xl border bg-card p-5 lg:col-span-2">
        <h2 id="h-sightings" className="text-lg font-semibold">
          Machinery tags to check ({sightings.length})
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tagged by the public on dated close-ups in Ground view. Open the same close-up, confirm what is there, then decide.
        </p>
        <SightingQueue items={sightings} />
      </section>

      <section aria-labelledby="h-review" className="rounded-xl border bg-card p-5 lg:col-span-2">
        <h2 id="h-review" className="text-lg font-semibold">
          Newest unreviewed detections
        </h2>
        <ul className="mt-3 divide-y text-sm">
          {unreviewed.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <a href={`/event/${e.id}`} className="text-link underline">
                  {e.title}
                </a>{" "}
                <span className="text-muted-foreground">{e.severity}</span>
              </span>
              <span className="tabular-nums text-muted-foreground">{e.detectedAt.toISOString().slice(0, 16).replace("T", " ")}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
