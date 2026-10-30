import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { DataExplorer } from "@/components/data/data-explorer";
import { listRegions } from "@/lib/db/repo/boundaries";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({ params }: PageProps<"/[locale]/data">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "data" });
  return { title: t("title"), description: t("intro") };
}

/** Research entry point: filter, preview and download detections with provenance. */
export default async function DataPage({ params }: PageProps<"/[locale]/data">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "data" });
  const tn = await getTranslations({ locale, namespace: "nav" });
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <nav aria-label="Data section" className="mb-6 flex flex-wrap gap-2 text-sm">
          <span className="rounded-full bg-forest-50 px-3 py-1 font-medium text-forest-900">{t("title")}</span>
          <Link href="/data/api" className="rounded-full border px-3 py-1 hover:bg-accent">
            {t("apiDocs")}
          </Link>
          <Link href="/data/sources" className="rounded-full border px-3 py-1 hover:bg-accent">
            {tn("sources")}
          </Link>
          <Link href="/data/methods" className="rounded-full border px-3 py-1 hover:bg-accent">
            {tn("methods")}
          </Link>
          <Link href="/data/accuracy" className="rounded-full border px-3 py-1 hover:bg-accent">
            Accuracy
          </Link>
        </nav>
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <p className="mt-2 max-w-[70ch] text-muted-foreground">{t("intro")}</p>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <Link href="/monthly" className="rounded-lg border p-3 hover:bg-accent">
            <span className="font-medium">Monthly releases</span>
            <span className="block text-muted-foreground">The frozen Galamsey Index per district, sites, rivers and reserves as CSV and GeoJSON, with a manifest of file hashes and a DOI. CC BY 4.0.</span>
          </Link>
          <Link href="/data/api" className="rounded-lg border p-3 hover:bg-accent">
            <span className="font-medium">API</span>
            <span className="block text-muted-foreground">
              <code>/api/v1/national</code>, <code>/api/v1/index</code>, <code>/api/v1/scorecards/{"{district}"}</code>, <code>/api/v1/rivers</code> and the detections API.
            </span>
          </Link>
          <div className="rounded-lg border p-3">
            <span className="font-medium">Embed on your site</span>
            <span className="block text-muted-foreground">
              The league table: <code>{"<iframe src=\"/embed/rankings\" width=\"100%\" height=\"420\" loading=\"lazy\"></iframe>"}</code>. A district card: <code>/embed/district/{"{slug}"}</code>.
            </span>
          </div>
        </div>
        <Suspense fallback={null}>
          <ExplorerWithRegions />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function ExplorerWithRegions() {
  await connection();
  const regions = await listRegions();
  return <DataExplorer regions={regions.map((r) => r.name)} />;
}
