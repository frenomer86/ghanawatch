"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/** Current year for citations, read on the client so static pages stay prerenderable. */
export function CitationYear() {
  const year = useSyncExternalStore(subscribe, () => new Date().getFullYear(), () => null);
  return <>{year ?? "2026"}</>;
}
