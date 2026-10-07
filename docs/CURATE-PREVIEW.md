# Curate comparison preview

PIC-369's first human-only flow is available at **`/curate-preview.html`** on the
implementation branch. It uses the normal password gate, library, persistent
grouping and decision service. **Choices are real:** saving a decision updates
local human tags and queues their synchronization to Immich. Use a test instance
for initial review. The server runs bounded read-only metadata refresh and selective, paced Immich
similarity searches in the background with Stacks enabled and Immich configured.
No browser is required, including for new arrivals from Enrich. This processing
makes no AI requests or human decisions.

PIC-382 adds [candidate stacking algorithm 3](CURATE-ALGORITHM.md): wider time
candidates, contextual people signals, positive ThumbHash and reciprocal search
ranks. Repeated searches that strongly favor two separate subgroups can now
override a misleading ThumbHash match. The linked document owns exact rules,
bounds and version history. Every stack shows one [status badge](#stack-status);
open it beside the comparison checkbox controls, or **Why?** for a single photo,
for a concise explanation. It appears on hover, keyboard focus or tap without
moving the photos. Recorded reasons without a plain-language translation remain
visible. A small muted footer identifies the algorithm version and links to
[How stacks work](CURATE-ALGORITHM.md#how-stacks-work).
The stack lightbox exposes the same explanation through its badge.

The current `/curate.html` remains the default during this staging step. The
preview now includes **Pending** and **Decided**. The released page remains
accessible directly at `/curate.html` during testing. This temporary entry
point allows human-flow review before production AI applicability, rollout and
runtime acceptance are complete; it is not a second permanent Curate product.
The eventual default-page cutover must consolidate these entry points and retire
legacy grouping, rather than leaving both implementations active indefinitely.

For composition experiments, `/curate-stacking-lab.html` opens a
[temporary, read-only testing page](CURATE-STACKING-LAB.md). Unlike decisions
in this preview, its proposed partitions are never saved.

## Review flow

The header has three stable rows: Pending/Decided with grouping activity and
separate Stack Referee / Photo Referee progress bars;
All/Stacks/Singles on the left with date order, category and Search on the right;
then selection on the left with shown counts and active background progress
aligned together on the right. The header checkbox appears in Singles and Decided;
All still allows checking individual single-photo cards. Hiding Pending-only
filters or the selection checkbox does not move shared controls or the photo grid.
The page reserves scrollbar space to keep controls aligned between long and short views.
On narrow screens, **Filters** reveals date order, category and Search controls.
Counts and progress each keep their own line, and the selection slot remains
reserved in All and Stacks. Desktop keeps filters visible. The remembered sort is not changed by collapsing them.

While Enrich is running, a red notice to the left of the header spinner says
stacks may change as photos are added. It follows the live run state through
the existing status updates, without needing Refresh or an additional poll.
The notice stays on the lower of two reserved lines, with temporary update text
above it, so neither message shifts the other. On narrow screens, these lines
sit below the header controls and use the shorter **Enrich running — stacks may
change.** wording, readable without a hover tooltip.

Search updates after a short typing pause and keeps focus and cursor position
while loading results. Text entered during an active request becomes the next
search, with only the latest draft submitted. A failed request leaves that draft
editable; the contextual **Retry updates** button searches it again. Background regrouping waits while a
search draft has not been applied.

- **Pending** shows all pending photos by default. All, Stacks and Singles
  filter the same view. **All categories** can narrow it to the existing Enrich
  review categories (Candidates, Should Review and Unlikely, or customized labels).
  A mixed stack belongs to its highest-priority member category, as in production;
  filtering or matching one member in search always retains the **whole** stack.
- **Decided** shows individual photos with earlier human choices (including Fav), with search
  and date order. The lightbox labels the saved **Current** outcome separately from
  stack **Draft** choices; Yes is never filled by default. The saved decision button
  has a subtle tint on the card and in the lightbox; Decided photos have no duplicate
  outcome label over the image. Open a photo or use its card actions to change that choice.
  A newer concurrent decision invalidates the old action scope; it cannot be
  silently overwritten. Background checks continue for pending photos while you browse Decided.
- Cards show a cover, up to three member thumbnails, available caption, capture date/time and stack size. Filenames are omitted.
  Single-photo decision buttons are vertically centered in the same row as stack
  thumbnails, keeping descriptions and dates aligned underneath.
  Captions are limited to one line with an ellipsis so decision buttons stay
  aligned. Hover for the full caption, or open the lightbox to read it.
  The capture date stays on its line while checks run; the cover's status badge
  and chip change instead (see [Stack status](#stack-status)), without enlarging
  the card.
  **Yes / Skip / Fav / No** are direct actions for single photos: Yes keeps a
  photo, Skip marks it reviewed without keeping it, Fav keeps it as a favorite,
  and No marks it Never show. None of these deletes the photo. Click the image for
  large inspection; a stack opens its comparison directly, without a separate
  Compare button. The shared Settings gear
  opens the Curate section, without a second settings button on the page.
- **Check shown photos** checks the currently loaded photos in Singles or Decided.
  All and Stacks hide this header control; All retains each single-photo checkbox.
  Loading more does not check additional photos. The fixed bottom action bar does not move the grid. Checked singles expose the same
  **Yes / Skip / Fav / No** actions in one undoable operation
  (up to 1,000 photos). The server verifies these are still single photos at both
  operation creation and save; a regrouped photo requires a refresh.
- **Date taken → Oldest first / Newest first** orders the full result set before
  pagination. Stacks use their earliest known capture time in either direction;
  photos inside a stack remain in capture order. Undated comparisons stay last.
  Equal dates use deterministic first-member IDs (reversed for Newest first).
  Oldest first is the initial default; the choice is remembered in this browser.
  Changing sort resets pagination and opens a fresh view. Background arrivals
  appear automatically when browsing pauses, preserving date order and your place.
  Open comparisons and bulk selections keep their current view.
- Open a stack and use **Yes / Skip / Fav / No** beneath each photo. Click an
  image to enlarge it. These choices remain a draft until **Save** or **Save & next**; the
  footer counts each outcome separately. Unmarked photos default to Skip, which
  is neither deletion nor Never show.
  Selected choices use the same subtle fills as Decided: teal for Yes, gray for
  Skip, gold for Fav and red for No, in both the comparison and its lightbox.
- Stack checkboxes check photos for batch actions independently of their outcome.
  **Check all** checks all actionable photos; it does not mark them Yes. When any
  photos are checked, the same four choices appear beside the checked count.
  Applying one changes only those photos; **Clear checks** clears the checkboxes
  without undoing any draft choices. Nearby reference photos cannot be checked.
- **Save** returns to the grid. **Save & next** opens the next pending
  comparison after this item's capture-time position, in the current filters and
  date order. It opens a fresh view after the save, so the next comparison uses
  the latest grouping, and loads more pages when needed. It does not wrap to
  earlier items. An accepted save remains saved if opening the next item fails;
  Recovery and Undo remain available. Undo after continuation refreshes the grid.
  **Save & next** remains the primary button for every combination of outcomes,
  including Skip-all. The compact header reads **Compare stack · N photos**,
  with the stack status and Close on the right. A second toolbar holds checkbox
  controls, the recommendation count and **Shortcuts** help. On narrow screens
  the status uses its icon with the full accessible label and explanation.
- In a comparison, focus a photo using **Left/Right** or **1–9**, then use
  **Y / S / F / N** to mark its draft outcome. **Enter** on the focused card
  saves the comparison and continues after **at least one explicit draft choice**
  (including Skip), or when complete, applicable Photo Referee advice has seeded
  **suggested Yes choices**. In that case, Enter on the initially focused card
  confirms the suggested draft. An untouched all-Skip draft, including one with
  no suggested keepers, cannot be saved by Enter; initial focus or checking boxes
  alone does not enable it. The Save buttons still allow an intentional Skip-all.
  Enter on a button or image retains its normal action. Modified/repeated keys,
  inputs, reference photos and uncertain actions cannot invoke these shortcuts.
- Comparisons with more than ten photos open in a compact grid; **Compact grid**
  can be turned off for larger images. Each row sizes its image areas to the
  photos' proportions, capped to leave room for controls. Full photos remain
  uncropped, with decision buttons aligned across mixed orientations. All-landscape
  rows can be shorter; mixed rows retain some neutral space around wider images.
- In the comparison, the **gold star** alone identifies an AI recommendation;
  the filled Yes/Skip/Fav/No button identifies the draft choice. A single thin
  accent border and highlighted photo number identify keyboard focus. Checkboxes
  select a batch independently. Repeated per-photo Draft labels are replaced by
  one footer draft summary. Per-photo **Why?**, the recommendation count and
  **Shortcuts** open overlays on hover, focus or tap; Escape dismisses the overlay
  first. Photo Referee reasons remain available in full in the lightbox. Partial
  advice, separate comparisons and incomplete-check notices remain visible.
- The lightbox follows the production layout: the photo fills the available
  space beside a narrow panel with caption, tags, capture date, enrichment score,
  producing model/profile when available, and an Immich link. On narrow screens
  the information panel scrolls below the photo.
- The lightbox stays open while moving between single photos, including after a
  decision or Undo. It keeps the previous image visible until the next image is
  ready, briefly disabling decisions during the handoff. Adjacent images are
  preloaded with a bounded five-image cache; a loading label appears when needed.
  Closing the viewer cancels the pending transition. Failed previews show an
  explicit unavailable message rather than leaving the previous photo under new details.
- For **single photos**, buttons and production keyboard shortcuts save immediately:
  **Y/A** Yes, **S/V** Skip, **F** Fav, **N/R** No.
  In Pending, an accepted decision advances to the next loaded card (loading the next page
  when necessary); reaching a stack opens its complete comparison. Arrow keys
  browse without deciding. **Z** undoes the last accepted action, and **Escape**
  closes the viewer. Decided edits stay on the same photo for inspection. Modified/repeated keystrokes and typing in fields do not
  trigger decisions. A lost response holds the current photo and offers exact retry.
- In a **stack lightbox**, the same four buttons and **Y / S / F / N** keys change
  the draft choice. Keyboard marks advance to the next actionable photo; marking
  the last returns to the comparison without saving. Mouse buttons stay on the
  current photo. Arrows browse, and **K** toggles Yes/Skip and advances. Escape
  or Back to comparison returns to the draft. Save the complete comparison explicitly.
- Already-kept nearby photos are bounded reference context. They have no decision
  controls and are excluded from every outcome payload. Singles expose
  these references as sidebar thumbnails, with a return button to the pending photo.
- Stacks are a comparison aid. Choose any number of keepers without editing the
  stack first. There are no Remove from stack, Split into singles or Stack
  corrections controls. The status badge opens a read-only explanation overlay,
  available on hover, focus or tap. Escape dismisses the overlay
  before closing the comparison.
  Saved separations from earlier preview builds remain respected; removing these
  controls does not erase their data or change existing human decisions.
- The last-save receipt and **Undo last save (Z)** are available inside the
  comparison, including after Save & next opens another stack. This undoes the
  previous saved decision, not an unsaved draft; Undo returns to the grid after
  stack continuation. The compact footer keeps the outcome count, Undo and Save
  actions together on wide screens; on narrow screens the Save buttons share a
  second row, and the receipt text is available to assistive technology.
- Immediate Undo is conditional on no newer human decision on any affected photo.
  The last action remains undoable until its server deadline (30 minutes).
  After saving, the lightbox shows **Saved — press Z to undo** over the bottom
  of the photo for five seconds. This reminder does not move the layout, appears
  only after an accepted save (not a stack draft), and does not shorten the Undo
  window when it disappears. Another save starts a fresh reminder.
  The main page's last-action bar can be dismissed with **×** on its right edge.
  Dismissing it does not cancel synchronization or Undo; **Z** remains available
  on the grid as well as in the lightbox and comparison. Keyboard shortcuts are
  ignored while editing a field or while another action is pending. The next saved
  action shows the bar again.
  The visible Undo affordance does not survive a page reload; saved decisions and
  corrections do. Undo feedback says **Undid choices** and separately reports
  whether the restored tags have synchronized. Older decisions remain accessible
  from the preview’s **Decided** tab.
- Save acceptance and Immich synchronization are separate. A failed sync can be
  retried without repeating the human decision or invoking AI.

**Load more** only displays additional results; it is no longer needed to get
those photos checked. The count distinguishes stacks and single photos. Beside
it, counts of the loaded stacks that are checking, unsure or not fully checked
use the cards' icons, without shifting the photo grid. A small spinner beside
the referee progress rows indicates grouping activity across the pending queue; its tooltip
reads **Checking stacks · N remaining**. This is the overall pending-check queue,
including photos outside the current page or filters and while browsing Decided.
It includes queued and in-progress checks; finished incomplete checks leave the
remaining count. Each check covers a nearby group that may form several stacks,
so it is not a count of final stack cards. Paused work has an attention
indicator and a word in the header.

The two referee progress rows count **stacks across the entire pending library**,
not the displayed cards or the bounded AI request queue. They remain visible in
Decided and under search, category and All/Stacks/Singles filters. A stack that
needs several Photo Referee requests still counts once. Singles are excluded;
Stack Referee also excludes stacks outside its selected scope.

- **N stacks remaining · Working / Queued** covers outstanding work, including
  work waiting to be discovered by the bounded worker queue.
- **Waiting for grouping / Waiting for stack checks / Waiting for AI** explains
  prerequisites or shared-provider scheduling; it does not assume Enrich is
  always the other provider user. **Paused** retains work blocked by settings,
  provider or preview problems in the remaining count.
- **Up to date** means no automatic work remains for the current pending stacks.
  Finished limited/failed checks count as finished, not endless pending work.
  Hover, focus or tap a referee's name for successful/limited counts and details.
  **Off** reflects Settings, even if older advice remains visible on cards.

Each bar shows finished work (successful plus terminal limited outcomes) out of
that role's current pending-stack scope. This is not a lifetime completion count
or an ETA: Enrich arrivals, new evidence, splits and human decisions can change
the denominator. Counts say **Counting stacks…** until a current summary exists.
The server collects a shared, read-only summary in cooperative slices, normally
at most once every four seconds for unchanged grouping/settings, and sends it
through the existing status poll. A new grouping/settings generation invalidates
old counts. It creates no AI calls, new retry work or persisted progress history.

Cards and comparisons use the [stack status](#stack-status) badges: **Checking**
while work is queued or running (reduced-motion preferences stop the spinner),
**Checked** once settled, **Unsure** for inconclusive checks and **Not fully
checked** for incomplete, unavailable or processing-limited ones. Ordinary
completion does not certify a perfect stack. Hover explains the specific cause;
comparisons expose the same explanation through **Why?**, available on hover,
keyboard focus or tap. Successful but inconclusive searches remain
distinguishable from failed searches in the explanation.

The open comparison keeps the badge beside Close in the header; narrow screens
show its icon with the full accessible label. The stack lightbox uses the same
labels and reasons. Manual choices remain available in every status. Per-stack limitations do not use an
amber warning; the header retains that treatment for overall paused work.

Searches stay sequential but can start two seconds apart, up to 30 new automatic
requests per minute. Slow responses add breathing room. The open comparison gets
the next turn, followed by visible cards and other admitted groups; changing
focus never interrupts an in-flight search or alters a saved comparison.

Cards show which nearby photos are waiting for a similarity check or being checked,
with progress counts for uncertain pairs and any needed core-recovery context.
Photos with distant ThumbHashes stay together provisionally until search evidence
can resolve them; strong people differences and saved manual separations still
apply immediately. Larger hash-supported groups also receive verification
searches; small locally resolved comparisons and exact renditions can skip them. A completed check highlights
affected cards; the grid adopts the result when browsing pauses. No routine
Refresh button or More menu occupies the header.
Checks that leave grouping unchanged do not request a new view. Results are applied as a complete time-candidate
pass, never one search at a time. Missing targets and successful empty results
remain unknown unless repeated subgroup evidence resolves the relationship.
Successful searches with inconclusive results keep the compatible time grouping
provisional, labeled **Unsure**. Failed or unavailable searches do not fragment it.
Completed evidence is saved, so inactivity and server restarts do not repeat
unchanged checks. Finished incomplete checks retain their safe reason and
established grouping; interrupted in-flight work can repeat. Changes to photos,
people evidence or human corrections also require renewed checks for the affected
candidate.

Background updates appear automatically after a short browsing pause, at most
once every five seconds. Open comparisons/lightboxes, selected batches, open
menus, edited fields and pending action receipts prevent automatic replacement.
Closing a comparison allows updates to appear. The open comparison does not
show a routine close-to-refresh notice; its Why explanation remains available,
and real save-conflict guards remain. Its membership and keeper draft
never change underneath the user. Automatic updates retain the number of loaded
pages where possible and anchor the scroll position to a surviving card. The saved
view expires after 30 minutes; the page renews it at the same safe browsing pause,
even when no grouping updates are waiting. Open drafts and checked selections
remain intact until closed or cleared, with a brief notice that the view will
refresh when reviewing finishes. An expiry response for an older, replaced view
does not affect the current view. Comparison and save expiry guards still apply.
A failed update stops automatic replacement and reveals **Retry updates**, disabling decisions
until the view is reconciled. A failed similarity search gets one retry within the current pass. If it fails
again, that candidate finishes with limited evidence and leaves the pending
count. Its existing grouping remains usable, and human decisions work normally.
There is no long-term repair queue or control to retry finished checks.
**Retry updates** reloads a failed view; it does not restart finished checks.

Limited evidence does not ask the user to repair a stack. The header shows active
progress or paused work; once checks finish, it omits aggregate incomplete counts
and the idle warning icon. Per-stack explanations remain available.

These outcomes survive restart without keeping partial search rows or retry
deadlines. Source/connection changes may invalidate the outcome normally. Incomplete passes never supply partial ranking evidence
for regrouping.

Accepted pending decisions remove only their cards from the displayed snapshot
and Undo restores them there; this preserves navigation order while working
through singles. Finished checks also preserve untouched neighbouring groups
when decisions remove photos from their larger time cohort, across restart and
Refresh. New arrivals and material evidence/constraint changes can invalidate
that cached work. The next five comparisons in saved view order, then visible
cards, get search priority without cancelling an in-flight request or recording
permanent viewed state. Other cards do not regroup during an open comparison or viewer.
Decided edits and Undo after changing views reload a fresh view. Photo-information
refresh status is separate from AI status, and failed metadata refresh can be
requested again from the open comparison. Unknown metadata is not claimed complete.

The decision limit is 1,000 photos. A larger logical group remains intact; the
preview displays its first 50 photos with decisions disabled,
and explains that turning stacks off allows individual review. It never saves a
page-sized subset as though it were the whole stack. Known thumbnail failures
block Save until the previews can be retried.

### Stack status

PIC-371 gives every stack one grouping badge, with the same words on the card,
the open stack, **Why?** and the page header. When several apply, the first in
this list wins:

| Badge | Meaning |
| --- | --- |
| **Checking** (spinner) | Similarity checks or the Stack Referee are queued or running. The stack may still change; you can curate it now. |
| **AI checked** (✓ AI) | The Stack Referee confirmed this grouping or split it from a larger one. |
| **Unsure** (?) | The evidence was inconclusive. The Stack Referee or you decide. |
| **Not fully checked** (i) | A limit applied: too many photos for the AI check or for automatic comparison, or a similarity check that could not finish. |
| **Checked** (✓) | The default: Pictaria's checks settled the grouping. |

A single photo shows **Kept apart** (≠) only when clearly different embeddings,
different people, contrasting Immich searches, the Stack Referee or an earlier
split separated it from photos taken at the same time; plain single photos have
no badge. There is no badge for human corrections, because Curate Preview has
had no split controls since PIC-384; an earlier saved split still applies and
appears in **Why?** as "Your earlier split applies". Decided photos show their
decision only.

The badge's icon sits at the top right of the cover, with its word and explanation
in the tooltip and accessible label. Icon shapes distinguish states as well as
color. A stack shows only its photo count at the top left, such as "9 photos";
single photos have no count/status text chip. Two inset photo edges make stacks
stand out. The thumbnail strip and single-photo action buttons occupy the same
row, with descriptions and capture dates aligned below them. Missing descriptions
reserve the same space, and long descriptions truncate to one line.

The capture date stays put while checks run. When a newer grouping supersedes a
card on screen, from similarity checks, the Stack Referee or a new photo nearby,
the card and any open comparison keep a settled verdict such as **AI checked**,
gain an accent outline, and **Why?** says "A newer grouping is ready; it appears
when Curate refreshes." Work that produced the newer grouping no longer shows as
**Checking**. The page adopts it at the next idle moment, as before.

**Why?** repeats the badge as a verdict, then shows:

- a **Grouping → AI check** strip, each step with its state and, where a check
  could not run, why: for example "AI check: not possible, 34 photos is over
  the 30-photo limit". Configuration problems read as off here and are reported
  once in the page header;
- short **evidence rows**, strongest first: ✓ supports, ? unsure, ✗ keeps photos
  apart and · background, such as "✓ Embeddings · Very similar" or
  "· Taken · Within 4 seconds". A Stack Referee reason appears as plain text.

The page header counts the **loaded** stacks that are checking, unsure or not
fully checked, with the cards' icons, for example "12 checking · 6 unsure".
Photo-information and grouping problems stay as words there. Library-wide
grouping progress is in the activity spinner's tooltip; referee progress is
visible in the two header rows. These badges describe the current membership and applicable inputs:
changed photos or invalidated results never keep an AI badge, and open
comparisons retain their photos and draft choices as status updates arrive.

The Photo Referee (PIC-116) adds a gold **★** beside any badge when it suggests
keepers, with a count when more than one, a **Keepers** step in the strip, and
stars on the suggested photos in the open stack. The page reads a group's
`photoReferee` status (with `keepers` once complete) and the comparison's
`photoRecommendations.keeperIds`. A keeper star does not imply that the Stack
Referee ran. The lightbox shows per-photo reasons, and Why records batch
coverage and the provider/model. Complete applicable recommendations seed a new
untouched draft with Yes for suggested photos and Skip for the rest. Save still
confirms the human's choices; status polls never overwrite an open draft.
Partial comparisons and historical mixed batches stay manual. Photo Referee
never changes stack membership. New comparisons usually suggest one strong
representative; additional suggestions must have distinct worthwhile value.
Earlier saved advice remains usable without automatic re-evaluation. The
[Photo Referee guide](CURATE-PHOTO-REFEREE.md) explains upgrade behavior and
batch limitations.

Both referees are available as independent options, off by default on fresh
installs, using the configured shared Curate provider/model and a ten-photo
per-request ceiling. Saved on preferences are honored after upgrade; Photo
Referee may already have an on preference inherited from the legacy referee.
See the
[Stack Referee guide](CURATE-STACK-REFEREE.md) for initial evaluation limits and
test-instance rollout; synthetic tests exercise these states without live calls.

## Implementation boundaries

- `public/curate/client.js` owns serialized view/comparison opens, tab ownership
  and the operation outbox; `photos.js` renders photo/group controls; `page.js`
  coordinates the view; `explanation.js` owns the accessible explanation overlay.
  Layout is isolated in `comparisons.css`.
- The latest view ID is retained in session storage and passed as
  `replacesViewId` on reload, navigation return, filtering and post-action refresh.
  The selected order is recorded in the view lease and its immutable paged
  snapshot, so later pages and reload recovery cannot mix different orders.
  BroadcastChannel detects cloned session storage so a duplicate tab does not
  replace its original tab's live view. Browsers without BroadcastChannel use
  fresh views as a safety fallback; old views expire normally.
- Exact action payloads are persisted **before** mutation requests. An uncertain
  response locks further mutations and offers safe retry, including after reload.
  No new operation ID or changed keeper set is substituted. Deterministic rejected
  requests can be refreshed; storage failure prevents sending the mutation.
- Legacy separation receipts remain immutable and recoverable even though the
  preview no longer exposes stack-editing controls. Undo availability is obtained from current
  active/revision state, not inferred from the receipt. A lost reset acknowledgment
  can be reconciled against that current state.
- Group pages add only one compact cover record per group, with no evidence
  expansion. Comparison details remain paged at 50. `GET .../separations` lists up
  to 50 active corrections; `?id=…` reads current state. The metadata retry route
  takes a saved comparison ID and bounded offset, never arbitrary client IDs.
- Provider and saved settings defaults are unchanged. Preview grouping now uses
  candidate 3, or [candidate 4](CURATE-ALGORITHM.md#candidate-4-image-embeddings)
  when image embeddings are available; the released page and strict lab controls
  keep their existing rules.
- Enrichment schema **15** / persistent-state contract **18** adds optional
  correction-action metadata without rewriting existing partitions or decisions.
  The action is saved atomically with the separation; exact retries must preserve
  both the partition and its action. Existing records remain readable without
  fabricated history. An additive index supports the active-correction list.
- The current preview uses enrichment schema **18** / persistent-state contract
  **22**. Schema 16 added completed search evidence. The current result format
  also records terminal incomplete outcomes in that same bounded store. Draft
  retry checkpoints from the earlier unreleased preview are discarded; there is
  no separate retry table or persisted partial-pass state. Schema 18 adds the
  bounded-result member index used to preserve settled groupings after decisions;
  prior completed records are captured lazily without repeating searches.
- Startup creates the normal pre-migration recovery checkpoint. Downgrading to a
  binary using an older contract requires restoring the **complete** matching
  pre-upgrade checkpoint (including state metadata and databases); changing only
  the application image is blocked by the downgrade guard. See
  [upgrade and recovery](UPGRADING.md). The date-sort and combined-UI follow-ups add no further
  schema or persistent-state version change.

## Validation and remaining work

Automated coverage includes a filtered 52-photo comparison spanning API pages,
multi/zero keeper operations, read-only kept context, background stability,
lost-response recovery across reload, conflicting newer human intent, Undo,
legacy separation persistence/reset at the API layer, duplicated tabs, keyboard interaction and a
390-pixel viewport. Viewer keyboard selection, compact grids, single-photo
controls and failed-open recovery are also covered. Automatic-update tests cover
open comparisons, bulk selections, pagination/scroll preservation, a failed
replacement without retry loops, and bounded similarity retries that settle
incomplete groupings without blocking human choices.
Date-order coverage includes pagination, duplicate stacks spanning distant dates,
missing/equal dates, filters/search, browser preference, failed replacement,
background arrivals, decisions/Undo and persisted view order after restart.
Combined-UI tests also cover single-photo keyboard save/advance, page boundaries,
read-only references, explicit bulk scope, Decided edits, Undo across refresh, and
exact retry after a lost response. Protocol tests cover serialized replacement, rejected requests, unavailable
storage, exact retry and oversized-group admission. Existing foundation
and decision tests cover server restarts, input changes and atomicity.

The preview deliberately contains no actionable AI recommendations: old per-photo
ranks are not valid new comparison advice. Production check/keeper integration,
applicable versus historical advice states and full-set Apply AI advice belong to
the PIC-116/PIC-370/PIC-346 integration. PIC-369 stays open for that integration
and final default-page UX. Broader sorting choices, tag editing and a fuller persisted stack audit keep
their separately tracked scopes. This UI iteration implements single-photo bulk
selection; it never applies a bulk keeper choice to stacks.

Full production mixed-load/incremental-memory gates, 30k repeated browser workflow
acceptance, operational migration/cutover and owner visual review remain required
before v1.3 release. Local fixture/browser tests do not establish those gates.

### Keeper-advice follow-up (PIC-116)

This iteration remains human-only. When keeper advice is integrated, show the
recommendation distinctly and initialize only untouched drafts. Never overwrite
a human choice. Applicability follows the recorded check/policy state, including
the approved provider image-limit exception for clearly labeled unchecked-size
suggestions; it must not become a blanket requirement for a green check.
