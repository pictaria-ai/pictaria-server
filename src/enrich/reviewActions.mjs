export const ACTION_RULES = Object.freeze({
  approve: Object.freeze({ add: Object.freeze(['frame/eligible']), remove: Object.freeze(['frame/never-show', 'frame/reviewed']) }),
  reject: Object.freeze({ add: Object.freeze(['frame/never-show', 'frame/reviewed']), remove: Object.freeze(['frame/eligible', 'frame/favorite']) }),
  favorite: Object.freeze({ add: Object.freeze(['frame/eligible', 'frame/favorite']), remove: Object.freeze(['frame/never-show', 'frame/reviewed']) }),
  reviewed: Object.freeze({ add: Object.freeze(['frame/reviewed']), remove: Object.freeze(['frame/eligible', 'frame/favorite']) }),
  clear: Object.freeze({ add: Object.freeze([]), remove: Object.freeze(['frame/eligible', 'frame/favorite', 'frame/never-show', 'frame/reviewed']) }),
});
