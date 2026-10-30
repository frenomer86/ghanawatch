import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { Droplets } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { monthLabel, monthOf } from "@/lib/domain/index";
import { riverScores } from "@/lib/server/rivers/score";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ReachStrip } from "@/components/index/reach-strip";

export const metadata: Metadata = {
  title: "River scorecards",
  description: "Where the Pra, Ankobra, Offin, Birim, Tano, Densu, Oda and Bonsa turned brown this month, seen from space, with the drinking-water intakes on each river.",
};

/** Every watched river: kilometres discoloured this month, the reaches, the intakes, dredger radar targets. */
export default async function RiversPage({ params }: PageProps<"/[locale]/rivers">) {
  setRequestLocale(resolveLocale((await params).locale));
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <h1 className="text-3xl font-semibold">River scorecards</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Each watched river is cut into reaches of about 10 km. A reach is discoloured in a month when Sentinel-2 saw the water turn brown there, and
          heavily discoloured when the brown water covers 5 ha or more. Drinking-water intakes are marked on the reach they draw from. This is what a free
          10 m satellite can see, not a water-quality measurement.
        </p>
        <Suspense fallback={<Skeleton className="mt-6 h-96 w-full" />}>
          <Rivers />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Rivers() {
  await connection();
  const month = monthOf(new Date());
  const rivers = await riverScores(month);
  return (
    <>
      <p className="mt-6 text-sm text-muted-foreground">{monthLabel(month)}, month in progress; the frozen figures are in each monthly report.</p>
      <ul className="mt-4 space-y-4">
        {rivers.map((r) => (
          <li key={r.slug} className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-2 text-xl font-semibold">
                <Droplets className="size-5 text-river-600" aria-hidden />
                <Link href={`/rivers/${r.slug}`} className="underline-offset-2 hover:underline">
                  {r.river}
                </Link>
              </h2>
              <p className="text-sm tabular-nums text-muted-foreground">
                {r.mapped ? `${r.kmDiscoloured} of ${r.lengthKm} km discoloured` : "river line not mapped yet"}
                {r.kmHeavy ? ` · ${r.kmHeavy} km heavily` : ""}
                {r.dredgerTargets ? ` · ${r.dredgerTargets} dredger radar targets` : ""}
              </p>
            </div>
            {r.mapped && <ReachStrip reaches={r.reaches} />}
            {r.intakes.length > 0 && (
              <p className="mt-2 text-sm text-muted-foreground">
                Intakes: {r.intakes.map((i) => i.name).join("; ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
