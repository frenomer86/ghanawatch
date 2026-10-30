# Launch package

The first public release of the Galamsey Index. Everything here is a template the release job fills in or a
list to work through; nothing goes out until the backfill is complete and at least twelve months have passed
the confirmation sample.

| File | What it is |
|---|---|
| `press-release-template.md` | The structure the release job uses; edit the quotes and contacts here before the first release |
| `media-list.md` | Who gets the embargoed briefing, 48 hours before the release |
| `partners.md` | Who to brief before launch, and what each is asked for |
| `thread.md` | The X/Twitter thread for launch day |
| `explainer-script.md` | A 90-second explainer video, spoken in plain English with Twi captions |
| `embargo-note.md` | The note that goes with the briefing pack |

## Launch checklist

1. Backfill complete (`npm run pipeline:history` finished for every priority-2 cell, monthly, and every priority-1 cell, quarterly), and the 2026-10 history month agrees with the live scorecard within the likely range.
2. Twelve closed months with confirmation samples checked (`/admin`).
3. Intakes entered for every plant on the Pra, Ankobra, Offin, Birim, Tano, Densu, Oda and Bonsa.
4. `npm run release -- --dry-run` clean on the Wednesday before; Lighthouse mobile ≥ 90 on `/`, `/districts` and one district page.
5. WhatsApp channel created (`WHATSAPP_CHANNEL_URL`), Brevo sender verified (`BREVO_API_KEY`, `MAIL_FROM`), Zenodo token set (`ZENODO_TOKEN`).
6. Embargoed briefing pack sent 48 hours before: the PDF, the press release, three evidence pages, the cards for the ten worst districts.
7. Release Monday 06:00 GMT; WhatsApp post from `public/alerts/latest.txt` and `public/releases/{month}/whatsapp.txt`; thread from `thread.txt`.
