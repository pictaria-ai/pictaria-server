// Reasons recorded with each Curate grouping, as short stable codes. The page
// words every code (public/curate/explanation-copy.js), and a contract test
// requires that wording. A code keeps its meaning: a changed meaning gets a new
// code. Groupings saved before codes keep their English sentences, which the
// page translates to these codes. Rules that never change, such as the time
// window, are documented rather than recorded.
export const REASON = Object.freeze({
  stacksOff: 'stacks-off', // Stacking is off in Settings.
  alone: 'alone', // No other pending photo in the time window.
  unlinked: 'unlinked', // A single photo that nothing linked to, or kept from, its neighbors.
  provisional: 'provisional', // Joined for now: similarity is unknown.
  exact: 'exact', // The same original file and rendition.
  thumbhash: 'thumbhash', // Close ThumbHash previews.
  embeddingNear: 'embedding-near', // Very similar image embeddings.
  embeddingCorroborated: 'embedding-corroborated', // Middle-band embeddings, corroborated.
  ranks: 'ranks', // Reciprocal nearby Immich search ranks.
  rankRecovered: 'rank-recovered', // An asymmetric match kept through a strong core.
  embeddingAverage: 'embedding-average', // Groups joined on their average similarity.
  embeddingUndecided: 'embedding-undecided', // Some embedded pairs are unsettled.
  embeddingApart: 'embedding-apart', // Clearly different embeddings keep nearby photos apart.
  peopleApart: 'people-apart', // Supported people differences keep nearby photos apart.
  rankContrast: 'rank-contrast', // Repeated searches favor separate subgroups.
  savedSplit: 'saved-split', // A saved human separation keeps nearby photos apart.
  photoSplit: 'photo-split', // A whole-input Photo Referee comparison separated subjects.
  budget: 'budget', // Over the automatic checking limits: grouped by time only.
  preserved: 'preserved', // Membership kept from the opened view; reasons unavailable.
});
