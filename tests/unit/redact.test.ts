import { describe, expect, it } from "vitest";
import { redactContacts } from "@/lib/domain/redact";

describe("contact details removed from report descriptions", () => {
  it("removes phone numbers written the usual Ghanaian ways", () => {
    for (const n of ["0241234567", "024 123 4567", "024-123-4567", "(024) 123 4567", "+233 24 123 4567", "+233241234567", "233 24 123 4567", "+44 7700 900123"]) {
      const r = redactContacts(`Call me on ${n} for directions`);
      expect(r.text, n).toBe("Call me on [number removed] for directions");
      expect(r.removed).toBe(1);
    }
  });

  it("removes e-mail addresses and links", () => {
    expect(redactContacts("write to kofi.mensah@gmail.com").text).toBe("write to [email removed]");
    expect(redactContacts("video at https://youtu.be/abc123 and www.example.org/x").text).toBe("video at [link removed] and [link removed]");
    expect(redactContacts("see facebook.com/somebody").text).toBe("see [link removed]");
  });

  it("leaves coordinates, dates, sizes and amounts alone", () => {
    const s = "Pits at 6.6901, -1.6200 since 28/10/2026, about 300 m long; 2 excavators, 15 000 cedis a day, 4.5 ha.";
    expect(redactContacts(s)).toEqual({ text: s, removed: 0 });
  });
});
