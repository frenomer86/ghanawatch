import { describe, expect, it } from "vitest";
import { allowConfirmationMail, CONFIRMATION_MAILS_PER_ADDRESS, CONFIRMATION_MAILS_PER_DAY, escapeHtml, stripXmlInvalid } from "@/lib/server/mail";
import { linkPage, postedToken } from "@/lib/server/alerts/link-page";

/** Security review, 30 October 2026: escaping, the confirm/unsubscribe page, confirmation-mail flooding. */

describe("escapeHtml", () => {
  it("escapes quotes too, so it is safe inside attribute values", () => {
    expect(escapeHtml(`"><script>alert('x')</script>&`)).toBe("&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
  });
});

describe("stripXmlInvalid", () => {
  it("drops characters XML 1.0 forbids and keeps text, tabs, newlines and emoji", () => {
    expect(stripXmlInvalid("a\u0000b\u0008c\td\ne\u000Bf￾g\uD800h😀")).toBe("abc\td\nefgh😀");
  });
});

describe("linkPage", () => {
  it("escapes every value it is given and forbids scripts and framing", async () => {
    const res = linkPage({ title: "<b>T</b>", body: "B & b", button: `Go"`, action: "/api/v1/subscriptions/confirm", token: `x" onmouseover="alert(1)`, origin: "https://ghanawatch.example" });
    const html = await res.text();
    expect(html).not.toContain(`onmouseover="alert(1)"`);
    expect(html).toContain(`value="x&quot; onmouseover=&quot;alert(1)"`);
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("postedToken", () => {
  it("reads the token from a small form post", async () => {
    const r = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=abcdefghijklmnopqrstuvwxyz" });
    expect(await postedToken(r)).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("cuts off a large body with 413 instead of buffering it whole", async () => {
    const r = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${"a".repeat(64 * 1024)}` });
    await expect(postedToken(r)).rejects.toMatchObject({ status: 413 });
    const j = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "a".repeat(8000) }) });
    await expect(postedToken(j)).rejects.toMatchObject({ status: 413 });
  });
});

describe("allowConfirmationMail", () => {
  it(`sends at most ${CONFIRMATION_MAILS_PER_ADDRESS} confirmation emails to one address a day, however it is spelled`, () => {
    const victim = `victim-${Math.random()}@example.org`;
    const allowed = Array.from({ length: 6 }, (_, i) => allowConfirmationMail(i % 2 ? victim.toUpperCase() : ` ${victim} `));
    expect(allowed.filter(Boolean)).toHaveLength(CONFIRMATION_MAILS_PER_ADDRESS);
    expect(allowConfirmationMail(`someone-else-${Math.random()}@example.org`)).toBe(true);
  });

  it(`stops all confirmation emails for the day after ${CONFIRMATION_MAILS_PER_DAY}, so the digest keeps its sending quota`, () => {
    let sent = 0;
    for (let i = 0; i < CONFIRMATION_MAILS_PER_DAY + 20; i++) if (allowConfirmationMail(`bulk-${i}-${Math.random()}@example.org`)) sent++;
    expect(sent).toBeLessThanOrEqual(CONFIRMATION_MAILS_PER_DAY);
    expect(allowConfirmationMail(`late-${Math.random()}@example.org`)).toBe(false);
  });
});
