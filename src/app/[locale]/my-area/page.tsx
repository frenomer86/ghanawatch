import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { MyArea } from "@/components/my-area/my-area";

export async function generateMetadata({ params }: PageProps<"/[locale]/my-area">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "myArea" });
  return { title: t("title"), description: t("intro") };
}

export default async function MyAreaPage({ params }: PageProps<"/[locale]/my-area">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "myArea" });
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("intro")}</p>
        <MyArea />
      </div>
    </AppShell>
  );
}
