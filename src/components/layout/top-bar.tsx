"use client";

import { useTranslations } from "next-intl";
import { ChevronDown, Menu } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";
import { LanguageSwitcher } from "./language-switcher";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** The map stays one click away; everything else sits in three drop-down menus. */
const GROUPS = [
  {
    key: "groupWatch",
    items: [
      { href: "/districts", key: "districts" },
      { href: "/rivers", key: "rivers" },
      { href: "/monthly", key: "reports" },
      { href: "/alerts", key: "alerts" },
      { href: "/floods", key: "floods" },
      { href: "/power", key: "power" },
    ],
  },
  {
    key: "groupAct",
    items: [
      { href: "/report", key: "report" },
      { href: "/check", key: "checkLand" },
      { href: "/my-area", key: "myArea" },
    ],
  },
  {
    key: "groupMore",
    items: [
      { href: "/data", key: "data" },
      { href: "/how-it-works", key: "howItWorks" },
      { href: "/data/sources", key: "sources" },
      { href: "/about", key: "about" },
    ],
  },
] as const;

export function isActive(pathname: string, href: string) {
  if (href === "/data") return pathname === "/data" || (pathname.startsWith("/data/") && !pathname.startsWith("/data/sources"));
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Top bar: the map, then three drop-down menus (Watch, Take action, More). On phones the wordmark, language
 * and a menu with the same groups, next to the bottom navigation.
 */
export function TopBar({ className }: { className?: string }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <header className={cn("sticky top-0 z-40 h-topbar border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80", className)}>
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-4 px-4">
        <Link href="/" className="rounded-md" aria-label="GhanaWatch">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="hidden md:flex md:items-center md:gap-1">
          <NavLink href="/map" active={isActive(pathname, "/map")}>
            {t("map")}
          </NavLink>
          {GROUPS.map((g) => {
            const active = g.items.some((i) => isActive(pathname, i.href));
            return (
              <DropdownMenu key={g.key}>
                <DropdownMenuTrigger
                  className={cn(
                    "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent data-[state=open]:bg-accent",
                    active && "bg-forest-50 font-medium text-forest-900 dark:bg-secondary dark:text-foreground",
                  )}
                >
                  {t(g.key)}
                  <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  {g.items.map((i) => (
                    <DropdownMenuItem key={i.key} asChild>
                      <Link href={i.href} aria-current={isActive(pathname, i.href) ? "page" : undefined} className={cn("cursor-pointer text-sm", isActive(pathname, i.href) && "font-medium text-forest-900")}>
                        {t(i.key)}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <LanguageSwitcher />
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label={t("menu")}>
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-80">
              <SheetHeader>
                <SheetTitle>
                  <Wordmark />
                </SheetTitle>
              </SheetHeader>
              <nav aria-label="More" className="mt-2 flex flex-col gap-1 px-2">
                <Link href="/map" className={cn("rounded-md px-3 py-2.5 text-base hover:bg-accent", isActive(pathname, "/map") && "bg-forest-50 font-medium text-forest-900")}>
                  {t("map")}
                </Link>
                {GROUPS.map((g) => (
                  <div key={g.key} className="mt-3">
                    <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t(g.key)}</p>
                    {g.items.map((item) => (
                      <Link
                        key={item.key}
                        href={item.href}
                        className={cn("block rounded-md px-3 py-2.5 text-base hover:bg-accent", isActive(pathname, item.href) && "bg-forest-50 font-medium text-forest-900")}
                      >
                        {t(item.key)}
                      </Link>
                    ))}
                  </div>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
        "text-foreground",
        active && "bg-forest-50 font-medium text-forest-900 dark:bg-secondary dark:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
