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
bounds and version history. Open the small similarity-status icon beside the
comparison checkbox controls for a concise explanation. It appears on
hover, keyboard focus or tap without moving the photos. Its initial text uses
plain language grounded in recorded reasons; technical details are secondary.
The stack lightbox exposes the same explanation through **Why?**.

The current `/curate.html` remains the default during this staging step. The
preview now includes **Pending** and **Decided**; **More → Production Curate**
keeps the released page accessible during testing. This temporary entry
point allows human-flow review before production AI applicability, rollout and
runtime acceptance are complete; it is not a second permanent Curate product.
The eventual default-page cutover must consolidate these entry points and retire
legacy grouping, rather than leaving both implementations active indefinitely.

For composition experiments, the separate **Stacking lab** link opens a
[temporary, read-only testing page](CURATE-STACKING-LAB.md). Unlike decisions
in this preview, its proposed partitions are never saved.

## Review flow

The header has three stable rows: Pending/Decided with activity, Refresh and More;
All/Stacks/Singles on the left with date order, category and Search on the right;
then selection on the left with shown counts and active background progress
aligned together on the right. The header checkbox appears in Singles and Decided;
All still allows checking individual single-photo cards. Hiding Pending-only
filters or the selection checkbox does not move shared controls or the photo grid.
On narrow screens, **Filters** reveals date order, category and Search controls.
Counts and progress each keep their own line, and the selection slot remains
reserved in All and Stacks. Desktop keeps filters visible. The remembered sort is not changed by collapsing them.

While Enrich is running, a red notice to the left of the header spinner says
stacks may change as photos are added. It follows the live run state through
the existing status updates, without needing Refresh or an additional poll.
On narrow screens, notices use a reserved line below the header controls.

Search updates after a short typing pause and keeps focus and cursor position
while loading results. Text entered during an active request becomes the next
search, with only the latest draft submitted. A failed request leaves that draft
editable; **Refresh** searches it again. Background regrouping waits while a
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
  Captions are limited to one line with an ellipsis so decision buttons stay
  aligned. Hover for the full caption, or open the lightbox to read it.
  Waiting/checking progress temporarily replaces the capture date on its existing
  line. The date returns when checking stops, including incomplete or inconclusive
  outcomes; those details remain on the status icon and in the comparison.
  Long progress text is shortened with an ellipsis rather than enlarging the card.
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
  Refresh and Undo remain available. Undo after continuation refreshes the grid.
  **Save & next** remains the primary button for every combination of outcomes,
  including Skip-all. The compact header reads **Compare stack · N photos**;
  the check-status icon sits beside the checkbox controls.
- In a comparison, focus a photo using **Left/Right** or **1–9**, then use
  **Y / S / F / N** to mark its draft outcome. **Enter** on the focused card
  saves the comparison and continues **after at least one explicit draft choice**
  (including Skip). Initial focus or checking boxes alone does not enable this
  shortcut. The Save buttons still allow an intentional Skip-all. Enter on a
  button or image retains its normal action. Modified/repeated keys, inputs, reference photos and uncertain
  actions cannot invoke these shortcuts.
- Comparisons with more than ten photos open in a compact grid; **Compact grid**
  can be turned off for larger images. Equal-height image areas keep decision
  buttons aligned across different aspect ratios; photos are resized without cropping.
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
  corrections controls. The status icon opens a read-only explanation overlay,
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
  The visible Undo affordance does not survive a page reload; saved decisions and
  corrections do. Undo feedback says **Undid choices** and separately reports
  whether the restored tags have synchronized. Older decisions remain accessible
  from the preview’s **Decided** tab.
- Save acceptance and Immich synchronization are separate. A failed sync can be
  retried without repeating the human decision or invoking AI.

**Load more** only displays additional results; it is no longer needed to get
those photos checked. The count distinguishes stacks and single photos. A small
spinner beside **Refresh** indicates background activity across the pending queue;
**Checking stacks · N remaining** appears beside the count without shifting the photo grid.
This is the overall pending-check queue, including photos outside the current
page or filters and while browsing Decided. It includes queued and in-progress
checks; finished incomplete checks leave the remaining count. Each check covers a nearby
group that may form several stacks, so it is not a count of final stack cards.
Paused work has an attention indicator. Completed checks are quiet on cards; the
comparison still exposes their status and explanation.

Cards have a small status circle: a muted spinner while queued, a blue spinner
while checking, an amber **!** for incomplete/unavailable checks, and a muted
**i** for successfully checked but inconclusive groupings. Text labels explain each state;
reduced-motion preferences stop the animation. Comparisons resolved locally say
that no similarity search is needed. The open comparison uses a small icon at
the right of the checkbox controls, with status and reasons on hover, focus or tap.
The stack lightbox keeps the status text near the top. Pending, inconclusive or
incomplete checks explain that manual choices are still possible.
If an updated grouping becomes available, the notice explains that the current
comparison stays fixed and closing it lets the grid update.

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
affected cards; the grid adopts the result when browsing pauses. A single
**Refresh** button remains available and is highlighted when updates are waiting.
Checks that leave grouping unchanged do not request a new view. Results are applied as a complete time-candidate
pass, never one search at a time. Missing targets and successful empty results
remain unknown unless repeated subgroup evidence resolves the relationship.
**Check complete · similarity uncertain** keeps the compatible
time grouping provisional. Failed or unavailable searches do not fragment it.
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
pages where possible and anchor the scroll position to a surviving card. A failed
update stops automatic replacement and asks for **Refresh**, disabling decisions
until the view is reconciled. A failed similarity search gets one retry within the current pass. If it fails
again, that candidate finishes as **not fully checked** and leaves the pending
count. Its existing grouping remains usable, and human decisions work normally.
There is no long-term repair queue or Retry now control. **Refresh** reloads the
view; it does not restart finished checks.

An amber **!** means **Similarity not fully checked**; its explanation gives a
short reason. A muted **i** means **Check complete · similarity uncertain**:
searches succeeded but the evidence was inconclusive. Neither asks the user to
repair a stack. Completed supported work stays quiet on cards. The header shows
active progress or paused work; once checks finish, it omits aggregate incomplete
counts and the idle warning icon. Per-stack explanations remain available.
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
  candidate 3; the released page and strict lab controls keep their existing rules.
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
