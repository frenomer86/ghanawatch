import { useTranslations } from "next-intl";
import { TopBar } from "./top-bar";
import { BottomNav } from "./bottom-nav";
import { SiteFooter } from "./site-footer";
import { cn } from "@/lib/utils";

/**
 * Page frame: skip link, top bar, content, bottom navigation on phones.
 * `fullBleed` removes the max-width and padding for the map screen.
 */
export function AppShell({ children, fullBleed = false, className }: { children: React.ReactNode; fullBleed?: boolean; className?: string }) {
  const t = useTranslations("app");
  return (
    <>
      <a href="#main" className="skip-link">
        {t("skipToContent")}
      </a>
      <TopBar />
      <main
        id="main"
        tabIndex={-1}
        className={cn(
          "flex-1 outline-none",
          fullBleed ? "pb-bottomnav md:pb-0" : "mx-auto w-full max-w-[1600px] px-4 pt-8 md:px-6 md:pt-12",
          className,
        )}
      >
        {children}
      </main>
      {!fullBleed && <SiteFooter />}
      <BottomNav />
    </>
  );
}
