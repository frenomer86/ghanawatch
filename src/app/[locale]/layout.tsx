import type { Metadata, Viewport } from "next";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { resolveLocale } from "@/i18n/locale";
import { LazyToaster } from "@/components/ui/lazy-toaster";
import { RegisterServiceWorker } from "@/components/pwa/register-sw";
import "../globals.css";

/**
 * Source Serif 4 for headings and the published figures, Source Sans 3 for the interface and body copy: one
 * family designed to work together, the register of a statistical bulletin rather than an app. Both carry the
 * letters Twi needs (ɛ ɔ Ɛ Ɔ). The body face is the one preloaded.
 */
const heading = Source_Serif_4({
  variable: "--font-heading",
  subsets: ["latin", "latin-ext"],
  weight: ["600", "700"],
  display: "swap",
  preload: false,
});

const body = Source_Sans_3({
  variable: "--font-body",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600"],
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0c3b2b" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1512" },
  ],
};

export async function generateMetadata({ params }: LayoutProps<"/[locale]">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "app" });
  return {
    title: { default: t("name"), template: `%s – ${t("name")}` },
    description: t("tagline"),
    applicationName: t("name"),
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, statusBarStyle: "default", title: t("name") },
    formatDetection: { telephone: false },
    openGraph: { type: "website", siteName: t("name"), title: t("name"), description: t("tagline") },
  };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);

  return (
    <html lang={locale} className={`${heading.variable} ${body.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-dvh flex flex-col">
        <NextIntlClientProvider>
          {/* No component uses a tooltip, so there is no TooltipProvider here (it pulled the tooltip and
              positioning code into every page); add one around the component that needs it. */}
          {children}
          <LazyToaster position="bottom-center" />
          <RegisterServiceWorker />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
