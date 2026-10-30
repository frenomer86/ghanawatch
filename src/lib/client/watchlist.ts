"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Device-local watchlist ("My area"). Stored in localStorage so it works
 * without an account and offline; a later phase syncs it to the server.
 */
export interface WatchItem {
  id: string; // district code or `pt:<lon>,<lat>`
  kind: "district" | "point";
  name: string;
  lon: number;
  lat: number;
  bbox?: [number, number, number, number];
  radiusKm?: number;
  addedAt: string;
}

const KEY = "gw.watchlist.v1";
const EVENT = "gw:watchlist";

function read(): WatchItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WatchItem[]).filter((i) => i && typeof i.id === "string") : [];
  } catch {
    return [];
  }
}

function write(items: WatchItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, 50)));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* storage unavailable (private mode, quota) — the list simply does not persist */
  }
}

export function useWatchlist() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setItems(read());
    setReady(true);
    const sync = () => setItems(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const add = useCallback((item: Omit<WatchItem, "addedAt">) => {
    const current = read();
    if (current.some((i) => i.id === item.id)) return;
    write([{ ...item, addedAt: new Date().toISOString() }, ...current]);
  }, []);

  const remove = useCallback((id: string) => write(read().filter((i) => i.id !== id)), []);
  const has = useCallback((id: string) => items.some((i) => i.id === id), [items]);

  return { items, ready, add, remove, has };
}
