"use client";

import { useTranslations } from "next-intl";
import { ChevronDown, Menu } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { GROUPS, GROUP_TRIGGER_CLASS, MENU_BUTTON_CLASS, isActive, type NavGroup } from "./top-bar";
import { Wordmark } from "./wordmark";

/**
 * The top bar's drop-down menus and phone menu sheet. Loaded only when a visitor first reaches for a menu
 * (see LazyMenu in top-bar.tsx), so the menu and dialog code is not part of every page's first load.
 * Each renders already open, because it replaces the placeholder button the visitor just pressed.
 */
export function GroupDropdown({ group }: { group: NavGroup }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const active = group.items.some((i) => isActive(pathname, i.href));
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger className={cn(GROUP_TRIGGER_CLASS, active && "bg-forest-50 font-medium text-forest-900 dark:bg-secondary dark:text-foreground")}>
        {t(group.key)}
        <ChevronDown className="size-3.5 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {group.items.map((i) => (
          <DropdownMenuItem key={i.key} asChild>
            <Link href={i.href} aria-current={isActive(pathname, i.href) ? "page" : undefined} className={cn("cursor-pointer text-sm", isActive(pathname, i.href) && "font-medium text-forest-900")}>
              {t(i.key)}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PhoneMenu() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className={MENU_BUTTON_CLASS} aria-label={t("menu")}>
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
                <Link key={item.key} href={item.href} className={cn("block rounded-md px-3 py-2.5 text-base hover:bg-accent", isActive(pathname, item.href) && "bg-forest-50 font-medium text-forest-900")}>
                  {t(item.key)}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
