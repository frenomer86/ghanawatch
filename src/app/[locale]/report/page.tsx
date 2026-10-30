import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { ReportForm } from "@/components/report/report-form";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({ params }: PageProps<"/[locale]/report">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "report" });
  return { title: t("title"), description: t("intro") };
}

export default async function ReportPage({ params }: PageProps<"/[locale]/report">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "report" });
  return (
    <AppShell>
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("intro")}</p>
        <p className="mt-2 text-sm">
          <Link href="/reports" className="text-link underline">
            {t("seeCases")}
          </Link>
        </p>
        <ReportForm styleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron"} />
      </div>
    </AppShell>
  );
}
