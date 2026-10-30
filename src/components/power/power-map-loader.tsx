"use client";

import dynamic from "next/dynamic";

/** The live map is browser-only (it draws with WebGL). */
export const PowerMapLoader = dynamic(() => import("./power-map").then((m) => m.PowerMap), {
  ssr: false,
  loading: () => <div className="h-[24rem] w-full animate-pulse rounded-xl border bg-muted" />,
});
