"use client";

import { useEffect, useRef, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (...args: A) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(...args), delayMs);
  };
}
