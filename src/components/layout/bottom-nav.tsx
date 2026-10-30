"use client";

import { useTranslations } from "next-intl";
import { Bell, Camera, Database, Map as MapIcon, MapPin } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { isActive } from "./top-bar";

const ITEMS = [
  { href: "/map", key: "map", Icon: MapIcon },
  { href: "/alerts", key: "alerts", Icon: Bell },
  { href: "/my-area", key: "myArea", Icon: MapPin },
  { href: "/report", key: "report", Icon: Camera },
  { href: "/data", key: "data", Icon: Database },
] as const;

/** Five top-level destinations, icon + label, phones only (SRS §10.4). */
export function BottomNav() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 h-bottomnav border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="grid h-full grid-cols-5">
        {ITEMS.map(({ href, key, Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={key} className="h-full">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-0.5 text-xs",
                  active ? "text-forest-700 dark:text-forest-300" : "text-muted-foreground",
                )}
              >
                <span className={cn("rounded-full px-3 py-0.5", active && "bg-forest-100 dark:bg-secondary")}>
                  <Icon className="size-5" aria-hidden strokeWidth={active ? 2.25 : 1.75} />
                </span>
                <span className={cn(active && "font-medium")}>{t(key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
