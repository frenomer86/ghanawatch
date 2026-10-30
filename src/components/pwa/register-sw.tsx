"use client";

import { useEffect } from "react";

/**
 * Registers public/sw.js in production builds only. The worker caches the app
 * shell, static assets, basemap tiles and the last-seen API responses so the
 * map and alerts remain readable offline (SRS FR-09).
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
