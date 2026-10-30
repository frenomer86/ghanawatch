"use client";

import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FilmBarFrame {
  key: string;
  /** Full label for screen readers and the current-frame readout, e.g. "2 Oct 2026, single pass". */
  label: string;
  /** Short tick label, e.g. "2019" or "Oct". */
  short: string;
  kind: "mosaic" | "pass";
}

interface Props {
  frames: FilmBarFrame[];
  index: number;
  playing: boolean;
  onIndex: (i: number) => void;
  onPlaying: (on: boolean) => void;
  labels: { play: string; pause: string; previous: string; next: string; timeline: string };
  className?: string;
}

/** Transport controls for the satellite film: step, play and scrub through dated frames. */
export function FilmBar({ frames, index, playing, onIndex, onPlaying, labels, className }: Props) {
  const last = Math.max(0, frames.length - 1);
  const pos = (i: number) => (last === 0 ? 0 : (i / last) * 100);
  return (
    <div className={cn("flex items-center gap-1.5 rounded-lg border bg-card/95 p-1.5 shadow-md backdrop-blur", className)}>
      <Button size="icon" variant="ghost" className="size-9" onClick={() => onIndex(Math.max(0, index - 1))} aria-label={labels.previous} disabled={index <= 0}>
        <SkipBack className="size-4" aria-hidden />
      </Button>
      <Button size="icon" className="size-9" onClick={() => onPlaying(!playing)} aria-label={playing ? labels.pause : labels.play} aria-pressed={playing}>
        {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
      </Button>
      <Button size="icon" variant="ghost" className="size-9" onClick={() => onIndex(Math.min(last, index + 1))} aria-label={labels.next} disabled={index >= last}>
        <SkipForward className="size-4" aria-hidden />
      </Button>
      <div className="min-w-0 flex-1 px-2">
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.min(index, last)}
          onChange={(e) => {
            onPlaying(false);
            onIndex(Number(e.target.value));
          }}
          aria-label={labels.timeline}
          aria-valuetext={frames[index]?.label}
          className="block h-5 w-full cursor-pointer accent-[var(--primary)]"
        />
        <div className="relative mt-0.5 h-4 text-[10px] leading-none text-muted-foreground" aria-hidden>
          {frames.map((f, i) => {
            const showLabel = f.kind === "mosaic" ? frames.length <= 14 || i % 2 === 0 : i === last;
            return (
              <span key={f.key} className="absolute top-0 -translate-x-1/2 text-center tabular-nums" style={{ left: `${pos(i)}%` }}>
                <span className={cn("mx-auto block h-1 w-px", f.kind === "pass" ? "bg-primary" : "bg-muted-foreground/60")} />
                {showLabel && <span className={cn("mt-0.5 block whitespace-nowrap", i === index && "font-semibold text-foreground")}>{f.short}</span>}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
