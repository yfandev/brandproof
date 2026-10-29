# Test input photo (fixture)

This folder holds the product photo used to exercise BrandProof end to end. It is a
test input only — the app never loads it automatically, and nothing in the build reads
it. Files here are served statically, so a fixture placed in this folder is also
reachable at `/test/<filename>` on any deployment.

## Expected file

| | |
| --- | --- |
| Filename | `botanika-packshot.png` |
| Subject | Portrait pack shot: brown pump bottle on a white background |
| Printed text | `HYDRATING` / `MOISTURIZER` (upper label), `BOTANIKA` (lower label), `NATURAL INGREDIENTS · PLANT POWERED` (bottom line) |

## How it is used

1. **Studio:** upload the photo as the product reference, or press **Scan photo** to read
   its label text in the browser.
2. **Brand:** `BOTANIKA` — the required check, and the one line large enough to read reliably.
3. **Label lines:** `HYDRATING`, `MOISTURIZER`, `NATURAL INGREDIENTS · PLANT POWERED`.
   These are the small lines that stress small-text OCR; in v2 they are optional checks, so a
   run can start with the brand alone.
4. Generate a clip through Comfy Cloud, then **Verify product fidelity**. OCR evidence should
   find the brand on most sampled frames; the smaller lines are where a REVIEW or
   `NOT DETECTED` finding is expected rather than a fabricated PASS.

Any product photo with a legible printed label works in place of this fixture. Swap the photo
and type its text in the form — there is no expected-text data in the code to update.
