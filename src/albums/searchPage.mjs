import { UpstreamPaginationError, parseProgressingPage } from '../pagination.mjs';

export function parseSmartAlbumSearchPage(response, currentPage, pageSize, {
  label,
  requirePeople = false,
  seenAssetIds = new Set(),
} = {}) {
  const responseObject = response && typeof response === 'object' && !Array.isArray(response)
    ? response
    : null;
  const assetsObject = responseObject?.assets
    && typeof responseObject.assets === 'object'
    && !Array.isArray(responseObject.assets)
    ? responseObject.assets
    : null;
  const representations = [
    ...(Array.isArray(response) ? [{ kind: 'array', items: response }] : []),
    ...(Array.isArray(responseObject?.assets) ? [{ kind: 'assets', items: responseObject.assets }] : []),
    ...(Array.isArray(assetsObject?.items) ? [{ kind: 'assets.items', items: assetsObject.items }] : []),
    ...(Array.isArray(responseObject?.items) ? [{ kind: 'items', items: responseObject.items }] : []),
    ...(Array.isArray(responseObject?.data) ? [{ kind: 'data', items: responseObject.data }] : []),
  ];
  if (representations.length !== 1 || representations[0].items.length > pageSize) {
    throw new UpstreamPaginationError(`${label} returned an invalid or oversized item page.`);
  }
  const [{ kind, items }] = representations;
  if (items.some((asset) => (
    !asset
    || typeof asset !== 'object'
    || Array.isArray(asset)
    || typeof asset.id !== 'string'
    || !asset.id.trim()
    || (Object.hasOwn(asset, 'type') && (
      typeof asset.type !== 'string'
      || asset.type.trim().toUpperCase() !== 'IMAGE'
    ))
    || (requirePeople && (
      !Array.isArray(asset.people)
      || asset.people.some((person) => !validAssetPerson(person))
    ))
  ))) {
    throw new UpstreamPaginationError(`${label} returned an invalid asset entry.`);
  }

  const pageIds = items.map((asset) => asset.id);
  const uniquePageIds = new Set(pageIds);
  if (uniquePageIds.size !== pageIds.length || pageIds.some((assetId) => seenAssetIds.has(assetId))) {
    throw new UpstreamPaginationError(`${label} returned repeated asset entries.`);
  }

  const hasNestedCursor = Boolean(assetsObject && Object.hasOwn(assetsObject, 'nextPage'));
  const hasTopLevelCursor = Boolean(responseObject && Object.hasOwn(responseObject, 'nextPage'));
  if (hasNestedCursor && hasTopLevelCursor) {
    throw new UpstreamPaginationError(`${label} returned conflicting next-page fields.`);
  }
  if (kind === 'assets.items' && !hasNestedCursor && !hasTopLevelCursor) {
    throw new UpstreamPaginationError(`${label} omitted its next-page field.`);
  }
  if (kind !== 'assets.items' && hasNestedCursor) {
    throw new UpstreamPaginationError(`${label} returned pagination for a different item container.`);
  }
  const nextPage = parseProgressingPage(
    hasNestedCursor ? assetsObject.nextPage : hasTopLevelCursor ? responseObject.nextPage : null,
    currentPage,
    { label },
  );
  if (nextPage !== null && nextPage !== currentPage + 1) {
    throw new UpstreamPaginationError(`${label} returned a non-sequential next page.`);
  }
  if (items.length === 0 && nextPage !== null) {
    throw new UpstreamPaginationError(`${label} returned an empty page with a continuation.`);
  }
  for (const assetId of pageIds) {
    seenAssetIds.add(assetId);
  }
  return { items, nextPage };
}

function validAssetPerson(person) {
  if (!person || typeof person !== 'object' || Array.isArray(person)) {
    return false;
  }
  const id = person.id ?? person.personId ?? person.person?.id;
  return typeof id === 'string' && Boolean(id.trim());
}
