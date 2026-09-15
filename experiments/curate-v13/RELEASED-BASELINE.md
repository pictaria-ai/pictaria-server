# Released referee comparison (PIC-366)

The owner reports usually accepting the released referee's highlighted photo
when a stack contains genuinely similar alternatives. This is useful product
experience, not a measured accuracy estimate. Better stack formation is the
main product priority; retain working keeper criteria unless evidence supports
changing them. A wrong-looking choice and a different personal preference must
be judged separately.

## What this compares

Use the same three frozen, chronological ten-photo batches, rendition bytes,
image order and provider/model as the preceding keeper experiment. Change to
the **v1.2.1 referee-v2 prompt and response schema**, with its actual available
capture-time/legacy people-tag inputs. Do not tune its wording for this test.

`released-baseline.mjs` captures the request constructed by the released
`RefereeService.refereeGroup` with inert dependencies, then stops before answer
normalization or persistence. It checks a pinned SHA-256 of that service file.
No prompt is manually transcribed; no worker, database or Immich client starts.
The existing visual CLI then makes at most one real provider request per explicit
submission using the captured contract and the manifest's local images.

This compares two keeper approaches, including their schemas and supplied facts.
It does not isolate prompt wording alone or reproduce the entire live application:
the batches are frozen evaluation boundaries, and the images remain the prior
1024-long-edge previews rather than being fetched again at production size.

## Private manifest and invocation

Copy each prior batch manifest to a new private directory outside Git. Keep its
photo IDs, order and exact rendition bytes. Resolve relative paths correctly.
Remove `enumOrder` and `expected`; this schema uses one-based photo indices, not
alias enums, and the owner's reference is partial. The CLI rejects those fields
in baseline mode to prevent them being silently ignored.

Each photo can additionally supply `capturedAt` and `aiTags` from already saved
source metadata. Use only facts the released request would actually have: its
people description reads `ai/people/{none,one,couple,group}`. Do not invent tags
from the images, map custom taxonomy output to those legacy tags, or manufacture
a people count from recognized identities. Missing facts stay unknown. Record
metadata availability privately; no new enrichment or metadata fetch is needed.

```json
{
  "photos": [
    {"id": "p10", "file": "a.jpg", "mimeType": "image/jpeg", "capturedAt": "2026-01-01T12:00:00Z", "aiTags": ["ai/people/one"]},
    {"id": "p11", "file": "b.jpg", "mimeType": "image/jpeg"}
  ]
}
```

```sh
node --test test/experiments/curate-v13.test.mjs
node experiments/curate-v13/visual.mjs --role=released-keeper --manifest=/private/batch-1.json
```

Baseline mode accepts 2–10 images and preserves the existing per-image and total
byte limits. After checking each dry run, use the previously approved provider
configuration through private child-process environment variables. Add `--submit`
and a fresh `--out=/private/batch-1-result.json` to that invocation. Output is
private, outside the checkout, mode 600 and never overwritten. No fallback or
automatic retry. No deployment configuration is loaded by the CLI.

For this owner-approved pass, **three sequential requests maximum, including
failures**, one per original batch. No reversed order, prompt adjustment, extra
grouping request, final round or replacement request. A transport/configuration
or capture/mapping failure stops further submissions for diagnosis. Preserve an
invalid model answer and continue only to the next planned batch.

Reuse the verified native outgoing/incoming capture hook. Check actual outgoing
image count/bytes/order, one-based index mapping, both schema representations,
system/user prompt and provider settings. The private `requestPlan.prompt` and
prepared-image fingerprints support this comparison; they alone are not wire
evidence. Never capture or publish authorization headers.

## Reporting and owner review

The released UI highlights the lowest rank within each displayed multi-photo
subject group; it does not use every `keep=true` flag as a gold star. Singletons
leave the stack. The report keeps these separate:

* `bestRankedId`: rank 1 across the fixed input batch.
* `stackHighlights`: lowest rank in each returned subject group of two or more.
* `singlePhotoIds`: returned subject groups containing just one photo, no star.
* `keepIds`: all explicit model `keep=true` choices, independently of rank.

This is a rank projection within the frozen batch, not a replay of production
group discovery. Preserve the model's full groups, per-photo notes and eyes
observations. Convert one-based batch indices back to the original displayed
photo numbers independently; never mistake batch 2's `photo: 1` for global 01.

Strict validation requires exhaustive unique photo indices, a full rank
permutation and correctly typed response fields. For an invalid answer the
private report retains both the model answer and released `normalizePicks`
output, but exposes no scored/highlighted winners from that repaired result.
Raw provider envelopes belong in the independent private capture.

Return one row per batch with validity, best-ranked photo, subject-group
highlights, all keep flags, latency and request/image bytes. Compare against
the preceding experimental recommendations with batch provenance. Report the
owner's preferred-photo coverage only as partial-reference agreement, never a
general accuracy score or rejection of all other choices.

Prepare a private local viewer using the existing numbered images for owner
review: released rank highlights alongside earlier experimental keepers, with
the full batch available. Ask whether choices are good representatives, merely
different acceptable preferences, clearly inferior, or unnecessarily repetitive.
Keep original labels and results intact; no retrospective relabeling to match AI.

No benchmark repeat, new photo fetch, enrichment, curation, tag/album/settings
mutation, deployment, restart or merge. This comparison does not complete the
large-group/grouping/runtime acceptance gates or settle final v1.3 keeper counts.
