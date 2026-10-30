import { slugify } from "@/lib/domain/scorecards";

/**
 * The district a typed name means. An exact name wins; otherwise, among districts whose name contains
 * the words typed, the municipal or metropolitan one is what "Obuasi" or "Kumasi" means to a person, then
 * a single remaining match; when several districts still fit (an "Amansie" without Central, South or
 * West) nothing is guessed and the ranking is shown filtered by what was typed.
 */
export function resolveDistrict(q: string, names: string[]): string | null {
  const norm = (s: string) => slugify(s);
  const nq = norm(q);
  if (!nq) return null;
  const exact = names.find((n) => norm(n) === nq);
  if (exact) return exact;
  const stripped = nq.replace(/-(municipal|metropolitan|district|assembly)$/g, "");
  const exactStripped = names.find((n) => norm(n).replace(/-(municipal|metropolitan)$/g, "") === stripped);
  if (exactStripped) return exactStripped;
  const matches = names.filter((n) => norm(n).includes(nq) || (nq.length >= 6 && nq.includes(norm(n))));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const city = matches.filter((n) => /\b(municipal|metropolitan)\b/i.test(n) && norm(n).startsWith(nq));
    if (city.length === 1) return city[0];
  }
  return null;
}
