import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const t = useTranslations("errors");
  return (
    <main id="main" className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <h1 className="text-3xl font-semibold">{t("notFoundTitle")}</h1>
      <p className="mt-3 max-w-prose text-muted-foreground">{t("notFoundBody")}</p>
      <Button asChild className="mt-8">
        <Link href="/map">{t("goHome")}</Link>
      </Button>
    </main>
  );
}
