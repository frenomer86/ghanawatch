import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Satellite, ScanSearch, MapPinned, BellRing } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({ params }: PageProps<"/[locale]/how-it-works">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "methods" });
  return { title: t("title"), description: t("intro") };
}

/** Plain-language explanation for the public, without the techniques behind it. */
export default async function HowItWorksPage({ params }: PageProps<"/[locale]/how-it-works">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "methods" });

  const steps = [
    {
      Icon: Satellite,
      title: "Satellites pass over Ghana every few days",
      body: "Free, public satellite images cover the whole country on a fixed schedule. Some see through cloud; others need clear sky.",
    },
    {
      Icon: ScanSearch,
      title: "New images are compared with the past",
      body: "Where trees disappear, ground opens up, a new track is cut into a forest reserve, new ponds appear, a river turns muddy or a fire burns, the change is flagged with the date it was seen and how sure we are.",
    },
    {
      Icon: MapPinned,
      title: "Changes are checked before they are shown",
      body: "Each change is checked against its surroundings, and checks of random samples against before and after images are published on the accuracy page. Changes that could not be confirmed stay available as possible detections.",
    },
    {
      Icon: BellRing,
      title: "People check, share and report back",
      body: "Anyone can watch a district, share a detection or send a photo from the ground. Reports are checked automatically against the photo's own location and the satellite record, and a moderator can step in. The platform is a watch tool, not a judge of what is lawful.",
    },
  ];

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-lg text-ink-soft">{t("intro")}</p>
        <ol className="mt-10 space-y-8">
          {steps.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[3rem_1fr] gap-4">
              <div className="flex size-12 items-center justify-center rounded-full bg-forest-100 text-forest-700" aria-hidden>
                <s.Icon className="size-6" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">
                  <span className="sr-only">Step {i + 1}: </span>
                  {s.title}
                </h2>
                <p className="mt-2 text-foreground/90">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <section className="prose-gw mt-14">
          <h2>What the map cannot tell you</h2>
          <ul>
            <li>Whether a change is legal. Farms, roads and licensed mines look the same from orbit as unlicensed ones.</li>
            <li>What happened under cloud. In the rainy season there may be no clear optical image for weeks; radar helps but sees less detail.</li>
            <li>Changes smaller than about a tenth of a hectare, or slow changes that build up over months.</li>
            <li>Who did something. The platform never identifies people and does not use imagery sharp enough to do so.</li>
          </ul>
          <h2>More</h2>
          <p>
            See <Link href="/data/methods">how to read the map</Link>, the measured <Link href="/data/accuracy">accuracy</Link>, and the{" "}
            <Link href="/data/sources">data credits</Link>.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
