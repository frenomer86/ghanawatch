# Automatic checking of citizen reports

GhanaWatch publishes a citizen report as soon as a line of evidence that the reporter could not easily
fabricate ties it to the place and time it claims. A report that fails a hard check is rejected, and anything
else waits for new satellite passes for up to thirty days. No moderator is needed at any step. The rules live
in `src/lib/domain/auto-review.ts`, which is pure and unit-tested. The reviewer that applies them is
`src/lib/server/reports/auto-review.ts`, and it runs as the `reviewer` service (`npm run reports:review --
--watch`) using the website's limited database account. A moderator can still decide any report, and the
reviewer never writes to a report a moderator has decided, because the check and the write are a single SQL
statement.

## What happens to a report

1. **Upload** (`src/app/api/v1/reports/route.ts`). The route checks the file type from the file's own bytes and
   reads the GPS position, accuracy and capture time that the camera stored in the original photo
   (`src/lib/domain/exif.ts`, which handles JPEG, WebP and PNG; when the camera clock is missing, the capture
   time comes from the GPS fix's own UTC date and time). It then re-encodes the photo, which drops every
   metadata field. The position and time are kept privately as evidence and are never shown. Phone numbers,
   e-mail addresses and links are removed from the description (`src/lib/domain/redact.ts`). The form reports
   where the position came from: the photo, the phone's location or a pin. A report that waited offline keeps
   the time it was made. The satellite comparison starts as soon as the reporter has their answer.
2. **Photo screen** (`src/lib/server/reports/image-safety.ts`), run once per photo. A ViT classifier scores
   the likelihood of sexual content. YuNet finds faces in the whole picture and, for large photos, in
   overlapping tiles of about 900 px, so that small faces are found as well. Every face is pixelated and
   blurred in the stored copy before anything can be published.
3. **Evidence**, gathered again on every check:
   - satellite detections of a matching kind within 750 m, including any radar flood outline that contains the
     spot (for fire reports the detection must fall within three days of the report, and for flood reports
     within ten);
   - VIIRS or MODIS fire pixels within 2 km and three days of a fire report;
   - at least 50 mm of rain in a day, or 20 mm in an hour, over the district on the day of a flood report or
     the two days before it;
   - the detection the reporter linked to, if it lies within 2 km;
   - other people's reports of the same kind within 1 km and seven days, sent from another connection with
     another photo.
4. **Decision**, in this order:

| Outcome | When |
|---|---|
| Rejected | Safety score at least 0.85 (the photo is deleted); the same photo file was already sent, for this place or for another; the photo's GPS position is outside Ghana or more than 50 km from the reported spot; the photo was taken more than a year before the report |
| Published | The photo's GPS position lies within 500 m of the spot (or within the accuracy the phone recorded, up to 2 km) and the photo was taken within 30 days of the report; or there is at least one piece of evidence from step 3; or the phone's own location, accurate to 100 m, put the reporter on site with a photo taken within two days. In every case the photo must also have passed the safety screen with a score below 0.5 |
| Held | Anything else, including a borderline safety score or a screen that could not run. The report is checked again every three hours for three days, then daily |
| Closed as unverified | Held for 30 days with nothing to confirm it |

An automatically published report moves its public case trail from "reported" to "confirmed" with a note that
gives distances and dates and nothing about the reporter, for example: *Checked automatically: the photo's own
GPS position is 126 m from this spot and it was taken on 28 Oct 2026.* Its public satellite verdict becomes
"confirmed by satellite" when the evidence includes a satellite detection, a satellite fire or the linked
detection, and "not visible from space yet" otherwise. The case page shows whether a report was checked
automatically or by a moderator. Every automatic decision is written to the audit log with no actor.

## What a moderator sees

On `/admin`, reports that are still held appear with the automatic check's findings: the distance and age
of the photo, the safety score, the number of faces blurred, the evidence found and the time of the next
check. Below them is the reviewer's work from the past week, where each published report can be withdrawn
and each rejected one published anyway.

## Models

| Model | Purpose | Size | Licence | Where it lives |
|---|---|---|---|---|
| YuNet 2023mar (OpenCV Zoo) | Faces | 232 kB | MIT | `models/face_detection_yunet_2023mar.onnx`, SHA-256 checked when loaded |
| AdamCodd/vit-base-nsfw-detector, 8-bit ONNX | Sexual content | 88.5 MB | Apache-2.0 | Downloaded once from a pinned revision, SHA-256 checked, cached in `DATA_DIR/models` |

The face decoder is held to OpenCV's own: `tests/unit/image-safety.test.ts` compares its boxes and scores with
those of `cv2.FaceDetectorYN` on a committed test picture of drawn faces, and they agree to within 0.05 px and
1e-4 in score. On a real photograph the two give the same box and score as well. On a 2-vCPU sandbox, one
report takes about 0.7 s to screen and decide, of which about 0.6 s is the safety classifier.

## Limits

Every check can be fooled by someone set on fooling it. A photo's GPS tags can be edited, a phone's location
can be spoofed and two accounts can corroborate each other. The strongest evidence, a satellite detection,
is the one a reporter cannot fake, and a moderator can overturn any decision from the admin page. Many
messaging apps strip the location from photos, and those reports rely on the phone's location, on satellite
evidence or on other reporters.
