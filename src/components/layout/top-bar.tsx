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
      { href: "/monthly", key: "reports" },
      { href: "/districts", key: "districts" },
      { href: "/alerts", key: "alerts" },
      { href: "/land-and-water", key: "landWater" },
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

/** Masthead navigation: white on forest, the current section marked by a rule under it. */
export const GROUP_TRIGGER_CLASS =
  "inline-flex h-topbar items-center gap-1 whitespace-nowrap px-3 text-[0.9375rem] text-white/85 transition-colors hover:text-white data-[state=open]:text-white";
export const NAV_ACTIVE_CLASS = "text-white shadow-[inset_0_-3px_0_0_var(--sev-watch-fill)]";
export const MENU_BUTTON_CLASS = "md:hidden text-white hover:bg-white/10 hover:text-white";

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

/** The sections the Land and water page leads to; the menu shows Land and water as current on each of them. */
export const LAND_AND_WATER_SECTIONS = ["/rivers", "/floods", "/reservoirs", "/coast", "/air"] as const;

export function isActive(pathname: string, href: string) {
  if (href === "/data") return pathname === "/data" || (pathname.startsWith("/data/") && !pathname.startsWith("/data/sources"));
  if (href === "/land-and-water" && LAND_AND_WATER_SECTIONS.some((s) => pathname === s || pathname.startsWith(`${s}/`))) return true;
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
    <header className={cn("sticky top-0 z-40 h-topbar bg-forest-700 text-white", className)}>
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-6 px-4 md:px-6">
        <Link href="/" className="rounded-sm focus-visible:outline-white" aria-label="GhanaWatch">
          <Wordmark onDark />
        </Link>
        <nav aria-label="Primary" className="hidden md:flex md:items-center">
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
                  <button type="button" aria-haspopup="menu" aria-expanded={false} className={cn(GROUP_TRIGGER_CLASS, active && NAV_ACTIVE_CLASS)} {...h}>
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
      className={cn("inline-flex h-topbar items-center whitespace-nowrap px-3 text-[0.9375rem] text-white/85 transition-colors hover:text-white", active && NAV_ACTIVE_CLASS)}
    >
      {children}
    </Link>
  );
}
