import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { MessageCircle, Rss } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { AlertsFeed } from "@/components/feed/alerts-feed";
import { SubscribeForm } from "@/components/index/subscribe-form";
import { listDistrictNames, listRegions } from "@/lib/db/repo/boundaries";
import { slugify } from "@/lib/domain/scorecards";
import { pastDigests } from "@/lib/server/alerts/digest";

export async function generateMetadata({ params }: PageProps<"/[locale]/alerts">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "alerts" });
  return { title: t("title"), description: t("intro") };
}

/**
 * Alerts: the weekly digest (WhatsApp channel, email, RSS) at the top, then the reverse-chronological
 * feed of detections with type and region filters (FR-13).
 */
export default async function AlertsPage({ params, searchParams }: PageProps<"/[locale]/alerts">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "alerts" });
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("intro")}</p>
        <Suspense fallback={null}>
          <Notice searchParams={searchParams} />
        </Suspense>
        <Suspense fallback={null}>
          <Weekly />
        </Suspense>
        <h2 className="mt-10 text-2xl font-semibold">Every detection</h2>
        <Suspense fallback={null}>
          <FeedWithRegions />
        </Suspense>
      </div>
    </AppShell>
  );
}

/** The one-line confirmation after the email links; read inside Suspense so the page still prerenders. */
async function Notice({ searchParams }: { searchParams: PageProps<"/[locale]/alerts">["searchParams"] }) {
  const sp = await searchParams;
  if (sp.subscribed) return <p className="mt-3 rounded-md bg-forest-50 p-3 text-sm text-forest-900">Your subscription is confirmed.</p>;
  if (sp.unsubscribed) return <p className="mt-3 rounded-md bg-muted p-3 text-sm">You are unsubscribed.</p>;
  if (sp.expired) return <p className="mt-3 rounded-md bg-muted p-3 text-sm">That confirmation link has expired or was replaced by a newer one. Subscribe again below to get a fresh link.</p>;
  return null;
}

async function Weekly() {
  await connection();
  const [names, digests] = await Promise.all([listDistrictNames(), pastDigests(4)]);
  const channel = process.env.WHATSAPP_CHANNEL_URL;
  return (
    <section className="mt-6 rounded-xl border bg-card p-5" aria-labelledby="weekly-h">
      <h2 id="weekly-h" className="text-xl font-semibold">
        The weekly digest
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every Monday: the likely galamsey sites first seen from space in the last seven days, by district, each with its evidence page.
      </p>
      <div className="mt-4">
        <SubscribeForm districts={names.map((n) => ({ slug: slugify(n), name: n }))} />
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        {channel && (
          <a href={channel} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
            <MessageCircle className="size-4" aria-hidden /> WhatsApp channel
          </a>
        )}
        <a href="/api/v1/alerts/feed.xml" className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
          <Rss className="size-4" aria-hidden /> RSS
        </a>
        <a href="/api/v1/alerts/feed.json" className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
          JSON feed
        </a>
      </div>
      {digests.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">Past weeks</summary>
          <ul className="mt-2 space-y-3">
            {digests.map((d) => (
              <li key={d.weekEnding} className="rounded-md bg-muted/50 p-3 text-sm">
                <p className="font-medium">
                  Week ending {d.weekEnding}: {d.newSites} new sites in {d.districts} districts
                </p>
                <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-muted-foreground">{d.text.replace(/\*/g, "")}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

async function FeedWithRegions() {
  await connection();
  const regions = await listRegions();
  return <AlertsFeed regions={regions.map((r) => ({ id: r.id, name: r.name }))} />;
}
