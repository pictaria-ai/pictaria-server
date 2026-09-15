export const ACTION_RULES = Object.freeze({
  approve: Object.freeze({ add: Object.freeze(['frame/eligible']), remove: Object.freeze(['frame/never-show', 'frame/reviewed']) }),
  reject: Object.freeze({ add: Object.freeze(['frame/never-show', 'frame/reviewed']), remove: Object.freeze(['frame/eligible', 'frame/favorite']) }),
  favorite: Object.freeze({ add: Object.freeze(['frame/eligible', 'frame/favorite']), remove: Object.freeze(['frame/never-show', 'frame/reviewed']) }),
  reviewed: Object.freeze({ add: Object.freeze(['frame/reviewed']), remove: Object.freeze(['frame/eligible', 'frame/favorite']) }),
  clear: Object.freeze({ add: Object.freeze([]), remove: Object.freeze(['frame/eligible', 'frame/favorite', 'frame/never-show', 'frame/reviewed']) }),
});

export const HUMAN_TAGS = Object.freeze(['frame/eligible', 'frame/favorite', 'frame/never-show', 'frame/reviewed']);
// Frame commands deliberately retain their narrower meaning. `restore` is
// internal compensating work, never an action accepted by the review API.
export const SYNC_ACTION_RULES = Object.freeze({
  ...ACTION_RULES,
  frame_favorite: { add: ['frame/favorite'], remove: [] },
  frame_hide: { add: ['frame/never-show'], remove: ['frame/eligible'] },
  restore: { add: HUMAN_TAGS, remove: HUMAN_TAGS },
});
