# Curate comparison preview

PIC-369's first human-only flow is available at **`/curate-preview.html`** on the
implementation branch. It uses the normal password gate, library, persistent
grouping and decision service. **Choices are real:** saving a decision updates
local human tags and queues their synchronization to Immich. Use a test instance
for initial review. Merely opening the page starts bounded read-only metadata
refresh and selective, paced Immich similarity searches, not AI requests or human decisions.

PIC-382 adds [candidate stacking algorithm 3](CURATE-ALGORITHM.md): wider time
candidates, contextual people signals, positive ThumbHash and reciprocal search
ranks. Repeated searches that strongly favor two separate subgroups can now
override a misleading ThumbHash match. The linked document owns exact rules,
bounds and version history. Open
**Why this stack?** in a comparison for a concise explanation.

The current `/curate.html` remains the default during this staging step. The
preview now includes **To curate** and **Decided**; **More → Production Curate**
keeps the released page accessible during testing. This temporary entry
point allows human-flow review before production AI applicability, rollout and
runtime acceptance are complete; it is not a second permanent Curate product.
The eventual default-page cutover must consolidate these entry points and retire
legacy grouping, rather than leaving both implementations active indefinitely.

For composition experiments, the separate **Stacking lab** link opens a
[temporary, read-only testing page](CURATE-STACKING-LAB.md). Unlike decisions
in this preview, its proposed partitions are never saved.

## Review flow

- **To curate** shows all pending photos by default. All, Stacks and Singles
  filter the same view. **All categories** can narrow it to the existing Enrich
  review categories (Candidates, Should Review and Unlikely, or customized labels).
  A mixed stack belongs to its highest-priority member category, as in production;
  filtering or matching one member in search always retains the **whole** stack.
- **Decided** shows individual photos with earlier human choices, with search
  and date order. Open a photo or use its card actions to change that choice.
  A newer concurrent decision invalidates the old action scope; it cannot be
  silently overwritten. This view does not request stack similarity searches.
- Cards show a cover, caption (filename when unavailable), date and stack size.
  **Keep** and **Mark reviewed** are direct actions for single photos. **More**
  exposes Favorite and Never show. Click the image for large inspection; a stack
  opens its comparison first.
- **Select single photos** selects the singles currently loaded, excluding stacks.
  In Singles and Decided it reads **Select shown photos**; Stacks hides it.
  Loading more does not add photos to the selection. Selected singles can be
  kept, favorited, marked reviewed or marked Never show in one undoable operation
  (up to 1,000 photos). The server verifies these are still single photos at both
  operation creation and save; a regrouped photo requires a refresh.
- **Date taken → Oldest first / Newest first** orders the full result set before
  pagination. Stacks use their earliest known capture time in either direction;
  photos inside a stack remain in capture order. Undated comparisons stay last.
  Equal dates use deterministic first-member IDs (reversed for Newest first).
  Oldest first is the initial default; the choice is remembered in this browser.
  Changing sort resets pagination and opens a fresh view. Background arrivals
  remain behind a refresh notice until you explicitly load the updated view.
- Open a stack, inspect its members and select zero, one or several keepers.
  Click an image to enlarge it; the separate **Keep** button selects it.
  The action states the complete result, for example **Keep 2, mark 3 reviewed**.
  Unselected photos default to reviewed; this is neither deletion nor Never show.
  Zero-keeper saves have neutral styling.
- Comparisons with more than ten photos open in a compact grid; **Compact grid**
  can be turned off for larger images.
- The lightbox follows the production layout: the photo fills the available
  space beside a narrow panel with caption, tags, capture date, enrichment score,
  producing model/profile when available, and an Immich link. On narrow screens
  the information panel scrolls below the photo.
- For **single photos**, buttons and production keyboard shortcuts save immediately:
  **Y/A** Keep, **F** Favorite, **S/V** Mark reviewed, **N/R** Never show.
  In To curate, an accepted decision advances to the next loaded card (loading the next page
  when necessary); reaching a stack opens its complete comparison. Arrow keys
  browse without deciding. **Z** undoes the last accepted action, and **Escape**
  closes the viewer. Decided edits stay on the same photo for inspection. Modified/repeated keystrokes and typing in fields do not
  trigger decisions. A lost response holds the current photo and offers exact retry.
- In a **stack lightbox**, **K** toggles Keep and arrows browse members. Favorite
  and Never show choices also remain a draft until the complete comparison is
  saved. Escape or Back to comparison returns to that draft. **Remove from stack**
  is an immediate persistent correction. Single-photo decision shortcuts do not
  save individual stack members.
- Already-kept nearby photos are bounded reference context. They have no decision
  controls and are excluded from every outcome/correction payload. Singles expose
  these references as sidebar thumbnails, with a return button to the pending photo.
- Remove from stack separates that member from its current peers. Split into
  singles separates all current members. The photos remain pending. These
  constraints persist across refreshes and restarts. Stack corrections lists
  active corrections with the removed photo or explicit split action and a reset
  action. Older records without action metadata use a generic partition summary
  instead of guessing which action created them. Resetting
  does not undo human decisions or promise that grouping will recreate a stack.
- Immediate Undo is conditional on no newer human decision on any affected photo.
  The last action remains undoable until its server deadline (30 minutes).
  The visible Undo affordance does not survive a page reload; saved decisions and
  corrections do. Undo feedback says **Undid choices** and separately reports
  whether the restored tags have synchronized. Older decisions remain accessible
  from the preview’s **Decided** tab.
- Save acceptance and Immich synchronization are separate. A failed sync can be
  retried without repeating the human decision or invoking AI.

Cards have a small status circle: a muted spinner while queued, a blue spinner
while checking, a green check when ready, and an amber attention marker when
paused, limited, unavailable or still uncertain. Text labels explain each state;
reduced-motion preferences stop the animation. Comparisons resolved locally say
that no similarity search is needed. The open comparison uses the same markers.

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
affected cards and offers **Show updated stacks**; checks that leave grouping
unchanged do not ask for a refresh. Results are applied as a complete time-candidate
pass, never one search at a time. Missing targets and successful empty results
remain unknown unless repeated subgroup evidence resolves the relationship.
**Check complete · similarity uncertain** keeps the compatible
time grouping provisional. Failed or unavailable searches do not fragment it.
Completed evidence stays available while the
view is active, so repeated Refresh does not restart checks on a ten-minute timer.
After inactivity or a server restart, this bounded memory cache can be empty and
a fresh pass may be needed. Changes to photos, people evidence or human corrections
also require renewed checks for the affected candidate.

Background progress does not replace cards, comparison membership or the user's
selection. Explicit refresh, filter/search
changes open a replacement view. Accepted pending decisions remove only their
cards from the displayed snapshot and Undo restores them there; this preserves
navigation order while working through singles. Other cards do not regroup as a
side effect of a decision. Corrections, Decided edits and Undo after changing views
reload a fresh view. Photo-information
refresh status is separate from AI status, and failed metadata refresh can be
requested again from the open comparison. Unknown metadata is not claimed complete.

The decision limit is 1,000 photos. A larger logical group remains intact; the
preview displays its first 50 photos with decisions and corrections disabled,
and explains that turning stacks off allows individual review. It never saves a
page-sized subset as though it were the whole stack. Known thumbnail failures
block Save until the previews can be retried.

## Implementation boundaries

- `public/curate/client.js` owns serialized view/comparison opens, tab ownership
  and the operation outbox; `photos.js` renders photo/group controls; `page.js`
  coordinates the view. Layout is isolated in `comparisons.css`.
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
- Separation receipts remain immutable. Undo availability is obtained from current
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
- Startup creates the normal pre-migration recovery checkpoint. Downgrading to a
  binary using contract 17 or earlier requires restoring the **complete** matching
  pre-upgrade checkpoint (including state metadata and databases); changing only
  the application image is blocked by the downgrade guard. See
  [upgrade and recovery](UPGRADING.md). The date-sort and combined-UI follow-ups add no further
  schema or persistent-state version change.

## Validation and remaining work

Automated coverage includes a filtered 52-photo comparison spanning API pages,
multi/zero keeper operations, read-only kept context, background stability,
lost-response recovery across reload, conflicting newer human intent, Undo,
persistent Remove/Split/reset, duplicated tabs, keyboard interaction and a
390-pixel viewport. Viewer keyboard selection, compact grids, single-photo
controls, correction action history and failed-open recovery are also covered.
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
