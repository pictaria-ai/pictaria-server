export const MINIMUM_IMMICH_MAJOR = 2;

export function parseImmichVersion(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const { major, minor, patch, prerelease = null } = value;
  if (![major, minor, patch].every(isNonNegativeInteger)) {
    return null;
  }
  if (prerelease !== null && !isNonNegativeInteger(prerelease)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease,
    display: `${major}.${minor}.${patch}${prerelease === null ? '' : `-${prerelease}`}`,
  };
}

export function isImmichVersionSupported(version) {
  return Boolean(version && version.major >= MINIMUM_IMMICH_MAJOR);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
