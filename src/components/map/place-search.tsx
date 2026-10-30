"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { Search, X } from "lucide-react";
import { fetcher } from "@/lib/client/fetcher";
import { useDebouncedValue } from "@/lib/client/use-debounced";
import type { BoundarySummary } from "@/lib/db/repo/boundaries";
import { cn } from "@/lib/utils";

/** Accessible combobox over /api/v1/boundaries?q=; keyboard and touch friendly. */
export function PlaceSearch({ onSelect, className }: { onSelect: (b: BoundarySummary) => void; className?: string }) {
  const t = useTranslations("map");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(q.trim(), 200);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = /^[\p{L}\p{N}\s'’-]{2,80}$/u.test(debounced);
  const { data } = useSWR<{ items: BoundarySummary[] }>(valid ? `/api/v1/boundaries?q=${encodeURIComponent(debounced)}&limit=8` : null, fetcher, {
    keepPreviousData: true,
  });
  const items = valid ? data?.items ?? [] : [];

  useEffect(() => setActive(0), [debounced]);

  const choose = (b: BoundarySummary) => {
    onSelect(b);
    setQ(b.name);
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className={cn("relative", className)} role="combobox" aria-expanded={open && items.length > 0} aria-haspopup="listbox" aria-controls={listId} aria-owns={listId}>
      <label htmlFor={`${listId}-input`} className="sr-only">
        {t("search")}
      </label>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        id={`${listId}-input`}
        type="search"
        inputMode="search"
        autoComplete="off"
        enterKeyHint="search"
        value={q}
        placeholder={t("searchPlaceholder")}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${listId}-${items[active].id}` : undefined}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && items[active]) {
            e.preventDefault();
            choose(items[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="h-11 w-full rounded-lg border bg-card pl-9 pr-9 text-base shadow-sm outline-none ring-ring focus-visible:ring-3 md:text-sm"
      />
      {q && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setQ("");
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <X className="size-4" />
        </button>
      )}
      <ul
        id={listId}
        role="listbox"
        className={cn("absolute z-20 mt-1 w-full overflow-hidden rounded-lg border bg-popover shadow-md", (!open || items.length === 0) && "hidden")}
      >
        {items.map((b, i) => (
          <li
            key={b.id}
            id={`${listId}-${b.id}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(b)}
            className={cn("flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2.5 text-sm", i === active && "bg-accent")}
          >
            <span className="font-medium">{b.name}</span>
            <span className="text-xs text-muted-foreground">{b.level === "region" ? "Region" : b.parentName ?? "District"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
