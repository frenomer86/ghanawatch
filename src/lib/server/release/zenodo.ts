import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deposits a release's open-data files on Zenodo and returns the DOI. Needs ZENODO_TOKEN (a personal
 * access token with deposit scope); ZENODO_SANDBOX=1 uses the sandbox. Without a token the release is
 * complete but carries no DOI, and the manifest says so.
 */
export interface ZenodoDeposit {
  doi: string;
  recordUrl: string;
}

export async function depositOnZenodo(opts: { dir: string; files: string[]; title: string; description: string; month: string; version: string; log: (s: string) => void }): Promise<ZenodoDeposit | null> {
  const token = process.env.ZENODO_TOKEN;
  if (!token) {
    opts.log("zenodo: ZENODO_TOKEN not set, no DOI minted");
    return null;
  }
  const base = process.env.ZENODO_SANDBOX ? "https://sandbox.zenodo.org/api" : "https://zenodo.org/api";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await fetch(`${base}/deposit/depositions`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(30_000) });
  if (!created.ok) throw new Error(`zenodo: could not create a deposition (HTTP ${created.status})`);
  const dep = (await created.json()) as { id: number; links: { bucket: string } };
  // The upload address comes back in Zenodo's answer and the token is sent to it: only ever to Zenodo's
  // own host over https, and the deposition id is a number before it is put into a URL.
  if (!sameHttpsHost(dep.links?.bucket, base) || !Number.isSafeInteger(dep.id)) throw new Error("zenodo: unexpected deposition answer");
  for (const f of opts.files) {
    const body = readFileSync(join(opts.dir, f));
    const up = await fetch(`${dep.links.bucket}/${encodeURIComponent(f)}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: new Uint8Array(body), signal: AbortSignal.timeout(120_000) });
    if (!up.ok) throw new Error(`zenodo: upload of ${f} failed (HTTP ${up.status})`);
  }
  const meta = {
    metadata: {
      title: opts.title,
      upload_type: "dataset",
      description: opts.description,
      creators: [{ name: "GhanaWatch, KNUST" }],
      keywords: ["galamsey", "Ghana", "Sentinel-2", "illegal mining", "satellite monitoring"],
      license: "cc-by-4.0",
      version: `${opts.month}+index${opts.version}`,
      access_right: "open",
    },
  };
  const put = await fetch(`${base}/deposit/depositions/${dep.id}`, { method: "PUT", headers, body: JSON.stringify(meta), signal: AbortSignal.timeout(30_000) });
  if (!put.ok) throw new Error(`zenodo: metadata rejected (HTTP ${put.status})`);
  const pub = await fetch(`${base}/deposit/depositions/${dep.id}/actions/publish`, { method: "POST", headers, signal: AbortSignal.timeout(60_000) });
  if (!pub.ok) throw new Error(`zenodo: publish failed (HTTP ${pub.status})`);
  const rec = (await pub.json()) as { doi: string; links: { record_html?: string; html?: string } };
  opts.log(`zenodo: published ${rec.doi}`);
  return { doi: rec.doi, recordUrl: rec.links.record_html ?? rec.links.html ?? "" };
}

/** True when `url` is https on exactly the host of `base`. */
export function sameHttpsHost(url: unknown, base: string): boolean {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && u.host === new URL(base).host;
  } catch {
    return false;
  }
}
