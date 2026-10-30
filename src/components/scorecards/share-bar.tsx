"use client";

import { useState } from "react";
import { Check, Copy, Download, MessageCircle, Send, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One-click sharing for a scorecard: WhatsApp, X and Facebook open their own
 * share screens with the link (the card picture travels with the link as its
 * preview), plus copy link and download the card.
 */
export function ShareBar({ url, text, cardUrl, cardName }: { url: string; text: string; cardUrl: string; cardName: string }) {
  const [copied, setCopied] = useState(false);
  const enc = encodeURIComponent;
  const links = [
    { label: "WhatsApp", href: `https://wa.me/?text=${enc(`${text} ${url}`)}`, Icon: MessageCircle },
    { label: "X", href: `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`, Icon: Send },
    { label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`, Icon: Share2 },
  ];
  return (
    <div className="flex flex-wrap gap-2" aria-label="Share this scorecard">
      {links.map(({ label, href, Icon }) => (
        <Button key={label} asChild variant="outline" size="sm">
          <a href={href} target="_blank" rel="noopener noreferrer">
            <Icon className="size-4" aria-hidden />
            {label}
          </a>
        </Button>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            window.prompt("Copy this link", url);
          }
        }}
      >
        {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {copied ? "Copied" : "Copy link"}
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={cardUrl} download={cardName}>
          <Download className="size-4" aria-hidden />
          Download card
        </a>
      </Button>
    </div>
  );
}

/** The iframe snippet news sites paste to show a live scorecard. */
export function EmbedCode({ src, title }: { src: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const code = `<iframe src="${src}" title="${title.replace(/"/g, "&quot;")}" width="100%" height="330" style="border:0;max-width:560px" loading="lazy"></iframe>`;
  return (
    <div className="space-y-2">
      <textarea readOnly value={code} rows={3} aria-label="Embed code" className="w-full resize-none rounded-md border bg-muted/40 p-2 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* the text is selectable */
          }
        }}
      >
        {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {copied ? "Copied" : "Copy embed code"}
      </Button>
    </div>
  );
}
