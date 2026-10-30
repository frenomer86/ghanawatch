import { setRequestLocale } from "next-intl/server";
import { useTranslations } from "next-intl";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { WifiOff } from "lucide-react";

/** Served by the service worker when a navigation fails offline and nothing is cached for it. */
export default async function OfflinePage({ params }: PageProps<"/[locale]/offline">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return <Offline />;
}

function Offline() {
  const t = useTranslations("common");
  const tn = useTranslations("nav");
  return (
    <main id="main" className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <WifiOff className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="mt-4 text-2xl font-semibold">{t("offline")}</h1>
      <div className="mt-6 flex gap-3">
        <Button asChild>
          <Link href="/map">{tn("map")}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/alerts">{tn("alerts")}</Link>
        </Button>
      </div>
    </main>
  );
}
