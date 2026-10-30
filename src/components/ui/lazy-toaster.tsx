"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { ToasterProps } from "sonner";

const Toaster = dynamic(() => import("./sonner").then((m) => m.Toaster), { ssr: false });

/**
 * The toast host, mounted once the page is idle. Toasts only follow something the visitor did (a form
 * sent, a tag saved), so the 60 KB toast library stays off every page's first load; pages whose own
 * components call toast() load it with them anyway.
 */
export function LazyToaster(props: ToasterProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(t);
  }, []);
  return ready ? <Toaster {...props} /> : null;
}
