"use client";

import { useEffect, useState, type ComponentType, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Menu } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";
import { LanguageSwitcher } from "./language-switcher";
import { Button } from "@/components/ui/button";

/** The map stays one click away; everything else sits in three drop-down menus. */
export const GROUPS = [
  {
    key: "groupWatch",
    items: [
      { href: "/districts", key: "districts" },
      { href: "/rivers", key: "rivers" },
      { href: "/monthly", key: "reports" },
      { href: "/alerts", key: "alerts" },
      { href: "/floods", key: "floods" },
      { href: "/air", key: "air" },
      { href: "/reservoirs", key: "reservoirs" },
      { href: "/coast", key: "coast" },
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
export type NavGroup = (typeof GROUPS)[number];

export const GROUP_TRIGGER_CLASS =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent data-[state=open]:bg-accent";
export const MENU_BUTTON_CLASS = "md:hidden";

type Menus = typeof import("./top-bar-menus");
let menus: Promise<Menus> | null = null;
/** The menu code (Radix drop-down and dialog), fetched once, on the first hover, focus or press of a menu. */
const loadMenus = () => (menus ??= import("./top-bar-menus").catch((e: unknown) => ((menus = null), Promise.reject(e))));

/**
 * A menu button that is a plain button until the visitor reaches for it: hovering or focusing it fetches
 * the menu code, pressing it (click, Enter, Space or Arrow Down) swaps in the real menu, already open, with
 * focus inside it. Closing the menu returns focus to its trigger as usual.
 */
function LazyMenu({ render, placeholder }: { render: (m: Menus) => ComponentType; placeholder: (handlers: { onPointerEnter: () => void; onFocus: () => void; onClick: () => void; onKeyDown: (e: KeyboardEvent) => void }) => React.ReactNode }) {
  const [Real, setReal] = useState<ComponentType | null>(null);
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    loadMenus().then(
      // Keep the first menu made: a new component type would remount it and close it.
      (m) => live && setReal((current: ComponentType | null) => current ?? render(m)),
      () => live && setWanted(false),
    );
    return () => {
      live = false;
    };
  }, [wanted, render]);
  if (Real) return <Real />;
  const preload = () => void loadMenus().catch(() => undefined);
  return placeholder({
    onPointerEnter: preload,
    onFocus: preload,
    onClick: () => setWanted(true),
    onKeyDown: (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setWanted(true);
      }
    },
  });
}

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
              <LazyMenu
                key={g.key}
                render={(m) => {
                  const Group = () => <m.GroupDropdown group={g} />;
                  return Group;
                }}
                placeholder={(h) => (
                  <button type="button" aria-haspopup="menu" aria-expanded={false} className={cn(GROUP_TRIGGER_CLASS, active && "bg-forest-50 font-medium text-forest-900 dark:bg-secondary dark:text-foreground")} {...h}>
                    {t(g.key)}
                    <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                  </button>
                )}
              />
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <LanguageSwitcher />
          <LazyMenu
            render={(m) => m.PhoneMenu}
            placeholder={(h) => (
              <Button variant="ghost" size="icon" className={MENU_BUTTON_CLASS} aria-label={t("menu")} aria-haspopup="dialog" aria-expanded={false} {...h}>
                <Menu className="size-5" />
              </Button>
            )}
          />
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
