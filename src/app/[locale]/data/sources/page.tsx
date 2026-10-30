import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { listSources } from "@/lib/db/repo/sources";
import { SOURCE_REGISTRY } from "@/pipeline/sources";
import type { Locale } from "@/lib/domain/types";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({ params }: PageProps<"/[locale]/data/sources">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "sources" });
  return { title: t("title"), description: t("intro") };
}

/** Data credits: each provider's required attribution and licence, nothing about how the data is used. */
export default async function SourcesPage({ params }: PageProps<"/[locale]/data/sources">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "sources" });
  const td = await getTranslations({ locale, namespace: "data" });
  const tn = await getTranslations({ locale, namespace: "nav" });
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <nav aria-label="Data section" className="mb-6 flex flex-wrap gap-2 text-sm">
          <Link href="/data" className="rounded-full border px-3 py-1 hover:bg-accent">
            {td("title")}
          </Link>
          <Link href="/data/api" className="rounded-full border px-3 py-1 hover:bg-accent">
            {td("apiDocs")}
          </Link>
          <span className="rounded-full bg-forest-50 px-3 py-1 font-medium text-forest-900">{tn("sources")}</span>
          <Link href="/data/methods" className="rounded-full border px-3 py-1 hover:bg-accent">
            {tn("methods")}
          </Link>
        </nav>
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <p className="mt-2 max-w-[70ch] text-muted-foreground">{t("intro")}</p>
        <Suspense fallback={null}>
          <SourceList locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function SourceList({ locale }: { locale: Locale }) {
  await connection();
  void locale;
  const sources = (await listSources()).filter((s) => s.attributionText && LIVE.has(s.slug)).map((s) => ({ ...s, attributionText: creditLine(s.attributionText) }));
  return (
    <ul className="mt-8 divide-y rounded-xl border bg-card">
      {sources.map((s) => (
        <li key={s.slug} className="px-5 py-4">
          <p className="font-medium">{s.provider.split(" (")[0]}</p>
          <p className="mt-1 text-sm text-muted-foreground">{s.attributionText}</p>
          <p className="mt-1 text-xs text-muted-foreground">Licence: {s.licence}</p>
        </li>
      ))}
    </ul>
  );
}

const LIVE = new Set(SOURCE_REGISTRY.filter((r) => r.connection === "live").map((r) => r.slug));

/** The credit a licence asks for, without how the data was processed. */
function creditLine(text: string): string {
  return text.replace(/,? processed by .*$/, "").replace(/s+$/, "");
}
