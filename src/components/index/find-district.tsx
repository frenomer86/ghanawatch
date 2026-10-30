import { ArrowRight } from "lucide-react";
import { slugify } from "@/lib/domain/scorecards";

/**
 * "Find your district": a plain form with a datalist, so it works without JavaScript. The route handler
 * at /districts/find turns the typed name into the district's page.
 */
export function FindDistrict({ names, locale }: { names: string[]; locale: string }) {
  const action = locale === "en" ? "/districts/find" : `/${locale}/districts/find`;
  return (
    <form action={action} method="get" className="flex flex-wrap gap-2" role="search" aria-label="Find your district">
      <label htmlFor="find-district" className="sr-only">
        District name
      </label>
      <input id="find-district" name="q" list="district-names" placeholder="Type your district, e.g. Amansie Central" autoComplete="off" required className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm" />
      <datalist id="district-names">
        {names.map((n) => (
          <option key={n} value={n} data-slug={slugify(n)} />
        ))}
      </datalist>
      <button type="submit" className="inline-flex items-center gap-1 rounded-md bg-forest-900 px-4 py-2 text-sm font-medium text-white hover:bg-forest-700">
        See my district <ArrowRight className="size-4" aria-hidden />
      </button>
    </form>
  );
}
