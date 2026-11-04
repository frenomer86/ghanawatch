"use client";

import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { Button } from "@/components/ui/button";

const LABEL: Record<string, string> = { en: "English", tw: "Twi" };

/** Switches locale in place, keeping the current page. */
export function LanguageSwitcher() {
  const t = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const next = routing.locales.find((l) => l !== locale) ?? routing.defaultLocale;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="font-medium text-white/90 hover:bg-white/10 hover:text-white"
      aria-label={`${t("language")}: ${LABEL[next]}`}
      lang={next}
      onClick={() =>
        router.replace(
          // @ts-expect-error pathname and params come from the current route and are valid together
          { pathname, params },
          { locale: next },
        )
      }
    >
      {LABEL[next]}
    </Button>
  );
}
