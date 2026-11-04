import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeft, Clock, MapPin, Rotate3d, Satellite, ShieldCheck } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { uuidParam } from "@/lib/domain/validation";
import { getCase } from "@/lib/db/repo/cases";
import { currentUser } from "@/lib/server/auth";
import { groundViewHref } from "@/lib/explore/imagery";
import type { Locale } from "@/lib/domain/types";
import { AppShell } from "@/components/layout/app-shell";
import { CaseTimeline, VerdictBadge } from "@/components/cases/case-bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/reports/[id]">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "cases" });
  return { title: t("title"), robots: { index: false } };
}

// Each case is read on request: its trail changes as moderators act on it.
export const instant = false;

/** One citizen report as a public case: photo, satellite verdict and what has happened since. */
export default async function CasePage({ params }: PageProps<"/[locale]/reports/[id]">) {
  const { locale: l } = await params;
  const locale = resolveLocale(l);
  setRequestLocale(locale);
  return (
    <AppShell>
      <Suspense fallback={<Skeleton className="mx-auto h-96 max-w-5xl" />}>
        <CaseBody params={params} locale={locale} />
      </Suspense>
    </AppShell>
  );
}

async function CaseBody({ params, locale }: { params: PageProps<"/[locale]/reports/[id]">["params"]; locale: Locale }) {
  await connection();
  const { id } = await params;
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) notFound();
  const user = await currentUser();
  // The same rule as the API: pending reports (exact spot, photo) are for staff with two-step sign-in on.
  const moderator = (user?.role === "moderator" || user?.role === "admin") && !!user?.twoFactor;
  const c = await getCase(parsed.data, { moderator });
  if (!c) notFound();
  const [t, tr, tType, f] = await Promise.all([
    getTranslations({ locale, namespace: "cases" }),
    getTranslations({ locale, namespace: "report" }),
    getTranslations({ locale, namespace: "type" }),
    getFormatter({ locale }),
  ]);
  const day = (iso: string) => f.dateTime(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

  const back = (
    <Button variant="ghost" size="sm" asChild className="-ml-2">
      <Link href="/reports">
        <ArrowLeft className="size-4" aria-hidden />
        {t("back")}
      </Link>
    </Button>
  );

  if (!("category" in c)) {
    const key = c.status === "rejected" ? "rejected" : c.status === "needs_info" ? "needsInfo" : c.status === "unverified" ? "unverified" : "pending";
    return (
      <div className="mx-auto max-w-2xl">
        {back}
        <div className="mt-4 rounded-lg border bg-card p-6">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Clock className="size-5 text-primary" aria-hidden />
            {t(`${key}Title`)}
          </h1>
          <p className="mt-2 text-muted-foreground">{t(`${key}Body`)}</p>
          <p className="mt-3 text-xs text-muted-foreground">{t("reportedOn", { date: day(c.createdAt) })}</p>
        </div>
      </div>
    );
  }

  const category = tr(`category.${c.category}`);
  const check = c.satelliteCheck;
  const nearest = check?.detections[0];
  return (
    <div className="mx-auto max-w-5xl">
      {back}
      <div className="mt-2 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <article className="space-y-6">
          <header>
            <div className="flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={c.satelliteVerdict} />
              {c.checkedBy && (
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5" aria-hidden />
                  {t(c.checkedBy === "automatic" ? "checkedAuto" : "checkedModerator")}
                </span>
              )}
              <span className="text-sm text-muted-foreground">{t("reportedOn", { date: day(c.createdAt) })}</span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold leading-tight">
              {c.districtName ? t("caseTitle", { category, place: c.districtName }) : t("caseTitleNoPlace", { category })}
            </h1>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <MapPin className="size-4" aria-hidden />
              {[c.districtName, c.regionName].filter(Boolean).join(", ")}
              {c.districtName ? " · " : ""}
              <span className="tabular-nums">
                {c.lat.toFixed(3)}, {c.lon.toFixed(3)}
              </span>
            </p>
          </header>

          {c.photoUrl && (
            <figure className="overflow-hidden rounded-lg border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- served by our photo route, already re-encoded */}
              <img src={c.photoUrl} alt={t("photoAlt")} className="max-h-[70vh] w-full object-contain" />
            </figure>
          )}
          <p className="whitespace-pre-line text-base">{c.description}</p>
          <p className="text-xs text-muted-foreground">{t("locationNote")}</p>

          <section aria-labelledby="case-sat" className="rounded-lg border p-4">
            <h2 id="case-sat" className="flex items-center gap-1.5 text-sm font-semibold">
              <Satellite className="size-4 text-muted-foreground" aria-hidden />
              {t("satelliteHeading")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t(`verdictHelp.${c.satelliteVerdict}`)}</p>
            {check && (
              <>
                {check.detections.length > 0 ? (
                  <>
                    <p className="mt-3 text-sm font-medium">{t("detectionsNear", { count: check.detections.length, radius: check.radiusM })}</p>
                    <ul className="mt-1.5 space-y-1 text-sm">
                      {check.detections.map((d) => (
                        <li key={d.id}>
                          <Link href={`/event/${d.id}`} className="text-link underline">
                            {d.title}
                          </Link>{" "}
                          <span className="text-muted-foreground">
                            · {tType(d.type)} · {day(d.imageDate)} · {d.distanceM} m
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mt-3 text-sm">{t("noDetections", { radius: check.radiusM })}</p>
                )}
                {check.closeUp?.capturedOn && <p className="mt-2 text-xs text-muted-foreground">{t("newestCloseUp", { date: day(check.closeUp.capturedOn) })}</p>}
              </>
            )}
            <Button variant="outline" size="sm" className="mt-3" asChild>
              <Link href={groundViewHref(c.lat, c.lon, nearest?.id)}>
                <Rotate3d className="size-4" aria-hidden />
                {t("openGroundView")}
              </Link>
            </Button>
          </section>
        </article>

        <aside aria-labelledby="case-trail" className="lg:pt-10">
          <h2 id="case-trail" className="mb-4 text-sm font-semibold">
            {t("trailHeading")}
          </h2>
          <CaseTimeline events={c.timeline} current={c.caseStatus} />
        </aside>
      </div>
    </div>
  );
}
