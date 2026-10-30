import { readBody } from "@/lib/server/http";
import { escapeHtml } from "@/lib/server/mail";

/**
 * The small page behind the confirm and unsubscribe links in emails. The link itself changes nothing:
 * mail scanners and link previews follow every link in a message, so the action happens only when the
 * person presses the button, which posts the token back.
 */
export function linkPage(opts: { title: string; body: string; button: string; action: string; token: string; origin: string }): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(opts.title)} · GhanaWatch</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f4efe6;color:#13261d}main{max-width:32rem;margin:10vh auto;padding:2rem;background:#fff;border-radius:1rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:1.4rem;margin:0 0 .75rem}p{line-height:1.5}button{font:inherit;padding:.7rem 1.2rem;border:0;border-radius:.6rem;background:#1f5c3f;color:#fff;cursor:pointer}a{color:#1f5c3f}</style></head>
<body><main><h1>${escapeHtml(opts.title)}</h1><p>${escapeHtml(opts.body)}</p>
<form method="post" action="${escapeHtml(opts.action)}"><input type="hidden" name="token" value="${escapeHtml(opts.token)}"><button type="submit">${escapeHtml(opts.button)}</button></form>
<p><a href="${escapeHtml(opts.origin)}/alerts">GhanaWatch alerts</a></p></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
}

/**
 * The token from a posted form or a JSON body. The body is read through a 4 KB ceiling (413 past it), so
 * a large or endless upload is cut off instead of being buffered whole before its size is looked at.
 */
export async function postedToken(req: Request): Promise<string | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.startsWith("application/x-www-form-urlencoded")) {
    const text = new TextDecoder().decode(await readBody(req, 4096));
    return new URLSearchParams(text).get("token");
  }
  if (ct.startsWith("application/json")) {
    const text = new TextDecoder().decode(await readBody(req, 4096));
    try {
      const v = (JSON.parse(text) as { token?: unknown }).token;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}
