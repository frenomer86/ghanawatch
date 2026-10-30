import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Camera } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { listPublicCases } from "@/lib/db/repo/cases";
import type { Locale } from "@/lib/domain/types";
import { AppShell } from "@/components/layout/app-shell";
import { CaseStatusChip, VerdictBadge } from "@/components/cases/case-bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/reports">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "cases" });
  return { title: t("title"), description: t("intro") };
}

/** Approved citizen reports, newest first, each with its satellite verdict and case progress. */
export default async function CasesPage({ params }: PageProps<"/[locale]/reports">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "cases" });
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-semibold">{t("title")}</h1>
            <p className="mt-2 text-muted-foreground">{t("intro")}</p>
          </div>
          <Button asChild>
            <Link href="/report">
              <Camera className="size-4" aria-hidden />
              {t("reportCta")}
            </Link>
          </Button>
        </div>
        <Suspense fallback={<Skeleton className="mt-8 h-64 w-full" />}>
          <CaseList locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function CaseList({ locale }: { locale: Locale }) {
  await connection();
  const [items, t, tr, f] = await Promise.all([
    listPublicCases({ limit: 60 }),
    getTranslations({ locale, namespace: "cases" }),
    getTranslations({ locale, namespace: "report" }),
    getFormatter({ locale }),
  ]);
  if (items.length === 0) return <p className="mt-10 rounded-lg border border-dashed p-8 text-center text-muted-foreground">{t("empty")}</p>;
  return (
    <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((c) => {
        const category = tr(`category.${c.category}`);
        return (
          <li key={c.id}>
            <Link href={`/reports/${c.id}`} className="group block overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md">
              <div className="aspect-[4/3] bg-muted">
                {c.photoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- served by our photo route, already re-encoded
                  <img src={c.photoUrl} alt={t("photoAlt")} loading="lazy" className="h-full w-full object-cover" />
                )}
              </div>
              <div className="space-y-2 p-3">
                <p className="font-medium leading-snug group-hover:underline">
                  {c.districtName ? t("caseTitle", { category, place: c.districtName }) : t("caseTitleNoPlace", { category })}
                </p>
                <p className="text-xs text-muted-foreground">{t("reportedOn", { date: f.dateTime(new Date(c.createdAt), { day: "numeric", month: "short", year: "numeric" }) })}</p>
                <div className="flex flex-wrap gap-1.5">
                  <VerdictBadge verdict={c.satelliteVerdict} />
                  <CaseStatusChip status={c.caseStatus} />
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
