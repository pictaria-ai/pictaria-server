# Curate comparison preview

PIC-369's first human-only flow is available at **`/curate-preview.html`** on the
implementation branch. It uses the normal password gate, library, persistent
grouping and decision service. **Choices are real:** saving a decision updates
local human tags and queues their synchronization to Immich. Use a test instance
for initial review. Merely opening the page starts bounded read-only metadata
refresh, not AI requests or human decisions.

The current `/curate.html` remains the default during this staging step. The
preview links back to it for Decided and existing workflows. This temporary entry
point allows human-flow review before production AI applicability, rollout and
runtime acceptance are complete; it is not a second permanent Curate product.
The eventual default-page cutover must consolidate these entry points and retire
legacy grouping, rather than leaving both implementations active indefinitely.

## Review flow

- All, Stacks and Singles show pending comparisons. Search can match one member
  but opens the **whole** saved stack. Grid pagination does not limit decisions.
- Open a stack, inspect its members and select zero, one or several keepers.
  The action states the complete result, for example **Keep 2, mark 3 reviewed**.
  Unselected photos default to reviewed; this is neither deletion nor Never show.
  A kept photo can be a favorite; an unselected photo can explicitly be Never show.
- A larger viewer shows the caption, tags and optional Immich link. Arrow keys
  navigate; Escape closes the innermost dialog. Native dialog focus trapping,
  checkbox keyboard controls and backdrop dismissal work on narrow screens.
- Already-kept nearby photos are bounded reference context. They have no decision
  controls and are excluded from every outcome/correction payload.
- Remove from stack separates that member from its current peers. Split into
  singles separates all current members. The photos remain pending. These
  constraints persist across refreshes and restarts. Stack corrections lists
  active corrections with explicit affected counts and a reset action; resetting
  does not undo human decisions or promise that grouping will recreate a stack.
- Immediate Undo is conditional on no newer human decision on any affected photo.
  The last action remains undoable until its server deadline (30 minutes).
  The visible Undo affordance does not survive a page reload; saved decisions and
  corrections do. Older decisions remain accessible from the current Curate page.
- Save acceptance and Immich synchronization are separate. A failed sync can be
  retried without repeating the human decision or invoking AI.

Background work only advertises **Updates available**. It does not replace cards,
comparison membership or the user's selection. Explicit refresh, filter/search
changes and successful local actions open a replacement view. Photo-information
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
- No provider, settings defaults, grouping threshold or schema-version changes.
  An additive index supports the active-correction list.

## Validation and remaining work

Automated coverage includes a filtered 52-photo comparison spanning API pages,
multi/zero keeper operations, read-only kept context, background stability,
lost-response recovery across reload, conflicting newer human intent, Undo,
persistent Remove/Split/reset, duplicated tabs, keyboard interaction and a
390-pixel viewport. Protocol tests cover serialized replacement, rejected requests,
unavailable storage, exact retry and oversized-group admission. Existing foundation
and decision tests cover server restarts, input changes and atomicity.

The preview deliberately contains no actionable AI recommendations: old per-photo
ranks are not valid new comparison advice. Production check/keeper integration,
applicable versus historical advice states and full-set Apply AI advice belong to
the PIC-116/PIC-370/PIC-346 integration. PIC-369 stays open for that integration
and final default-page UX. Sorting, top-level bulk selection, tag editing and
the stack explanation surface keep their separately tracked scopes.

Full production mixed-load/incremental-memory gates, 30k repeated browser workflow
acceptance, operational migration/cutover and owner visual review remain required
before v1.3 release. Local fixture/browser tests do not establish those gates.
