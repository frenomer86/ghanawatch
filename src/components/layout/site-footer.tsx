import { Link } from "@/i18n/navigation";
import { Wordmark } from "./wordmark";
import { CitationYear } from "@/components/domain/citation-year";

/**
 * The foot of every page: what GhanaWatch is, where its data and methods are, and the terms the figures are
 * published under.
 */
export function SiteFooter() {
  return (
    <footer className="mt-20 border-t bg-paper-deep pb-bottomnav md:pb-0">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:px-6">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-[38ch] text-[0.9375rem] text-ink-soft">
            An independent satellite record of the damage done to Ghana&apos;s land and water, published every month with the evidence behind it.
          </p>
        </div>
        <nav aria-label="The record">
          <h2 className="font-sans text-[0.9375rem] font-semibold">The record</h2>
          <ul className="mt-3 space-y-2 text-[0.9375rem]">
            <li><Link href="/monthly" className="hover:underline">Monthly reports</Link></li>
            <li><Link href="/districts" className="hover:underline">Districts</Link></li>
            <li><Link href="/land-and-water" className="hover:underline">Land and water</Link></li>
            <li><Link href="/alerts" className="hover:underline">Alerts</Link></li>
          </ul>
        </nav>
        <nav aria-label="Data">
          <h2 className="font-sans text-[0.9375rem] font-semibold">Data</h2>
          <ul className="mt-3 space-y-2 text-[0.9375rem]">
            <li><Link href="/data" className="hover:underline">Download</Link></li>
            <li><Link href="/data/api" className="hover:underline">API</Link></li>
            <li><Link href="/data/methods" className="hover:underline">Methods and accuracy</Link></li>
            <li><Link href="/data/sources" className="hover:underline">Sources and credits</Link></li>
          </ul>
        </nav>
        <nav aria-label="Take part">
          <h2 className="font-sans text-[0.9375rem] font-semibold">Take part</h2>
          <ul className="mt-3 space-y-2 text-[0.9375rem]">
            <li><Link href="/report" className="hover:underline">Report what you see</Link></li>
            <li><Link href="/check" className="hover:underline">Check a piece of land</Link></li>
            <li><Link href="/my-area" className="hover:underline">Watch your area</Link></li>
            <li><Link href="/about" className="hover:underline">About GhanaWatch</Link></li>
          </ul>
        </nav>
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-6xl px-4 py-5 text-sm text-muted-foreground md:px-6">
          Figures and maps are published under Creative Commons Attribution 4.0 and contain modified Copernicus Sentinel data. A satellite
          detection is evidence of change, not a legal finding; the Minerals Commission, the Environmental Protection Agency, the Forestry
          Commission and NADMO remain the authorities. © <CitationYear /> GhanaWatch.
        </p>
      </div>
    </footer>
  );
}
