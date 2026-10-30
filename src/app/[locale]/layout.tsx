import type { Metadata, Viewport } from "next";
import { Lexend, Source_Sans_3 } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { resolveLocale } from "@/i18n/locale";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { RegisterServiceWorker } from "@/components/pwa/register-sw";
import "../globals.css";

/**
 * Lexend for headings and interface labels, Source Sans 3 for body copy.
 * Both include the Latin Extended glyphs Twi needs (ɛ ɔ Ɛ Ɔ). Only two
 * weights of each are loaded; the body face is the one preloaded.
 */
const heading = Lexend({
  variable: "--font-heading",
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600"],
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
    { media: "(prefers-color-scheme: light)", color: "#0f3d2e" },
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
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster position="bottom-center" />
            <RegisterServiceWorker />
          </TooltipProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
