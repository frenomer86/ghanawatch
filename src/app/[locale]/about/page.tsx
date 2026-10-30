import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({ params }: PageProps<"/[locale]/about">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "about" });
  return { title: t("title") };
}

export default async function AboutPage({ params }: PageProps<"/[locale]/about">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "about" });
  const tf = await getTranslations({ locale, namespace: "footer" });
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <div className="prose-gw mt-6">
          <p>
            GhanaWatch is a free, public platform that turns open satellite and environmental data into a national picture of vegetation
            loss, disturbed ground, water changes and flood risk across Ghana. It exists so that communities, district assemblies, NADMO
            officers, journalists, researchers and anyone else can see what is changing, when it was seen, and how sure the data is.
          </p>
          <h2>Who it is for</h2>
          <ul>
            <li>Residents who want to know what is happening around their town or farmland, and be told when something new appears.</li>
            <li>Local authorities and NADMO officers who need situational awareness to prioritise response and cross-check official reports.</li>
            <li>Journalists who need dated, locatable evidence.</li>
            <li>Researchers and students who need downloadable, citable records with provenance.</li>
            <li>Environmental organisations monitoring priority zones and supporting field verification.</li>
          </ul>
          <h2>Principles</h2>
          <ul>
            <li>Open data only, credited as each licence requires.</li>
            <li>Exact image dates and confidence on every record; limitations stated plainly.</li>
            <li>Calm, careful language: a detected change, not an accusation.</li>
            <li>Mobile first and light on data, because most people in Ghana will use it on a phone.</li>
            <li>No identification of individuals, ever.</li>
          </ul>
          <h2>Disclaimer</h2>
          <p>{tf("disclaimer")}</p>
          <h2>Contact</h2>
          <p>
            To reach the GhanaWatch team, use the <Link href="/report">report form</Link> and choose &quot;Something else&quot;. Reports are read by
            moderators, and you can stay anonymous.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
