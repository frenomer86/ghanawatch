import { connection } from "next/server";
import { listEvents } from "@/lib/db/repo/events";
import type { Locale } from "@/lib/domain/types";
import { EventCard } from "@/components/domain/event-card";

export async function HomeFeed({ locale }: { locale: Locale }) {
  await connection();
  const page = await listEvents({ limit: 6, format: "json" }, locale);
  return (
    <ul className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {page.items.map((e) => (
        <li key={e.id}>
          <EventCard event={e} />
        </li>
      ))}
    </ul>
  );
}
