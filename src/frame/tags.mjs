export const FRAME_FAVORITE_TAG = 'frame/favorite';
export const FRAME_ELIGIBLE_TAG = 'frame/eligible';
export const FRAME_NEVER_SHOW_TAG = 'frame/never-show';

export async function getFrameEligibleTagId(immich) {
  const tags = await immich.listTags();
  const tag = tags.find((candidate) => tagMatchesValue(candidate, FRAME_ELIGIBLE_TAG));
  return tag?.id ?? null;
}

export async function getRequiredFrameEligibleTagId(immich, createError) {
  const tagId = await getFrameEligibleTagId(immich);

  if (!tagId) {
    throw createError();
  }

  return tagId;
}

export function findFrameTag(tags, tagValue) {
  return tags.find((tag) => tagMatchesValue(tag, tagValue));
}

function tagMatchesValue(tag, tagValue) {
  return tag?.value === tagValue || tag?.name === tagValue;
}
