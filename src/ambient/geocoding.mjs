import { createBoundedMap } from '../boundedMap.mjs';
import { fetchWithTimeout } from '../fetchWithTimeout.mjs';

const UNITED_STATES_NAMES = new Set(['united states', 'united states of america', 'usa', 'us']);
// Geoapify reverse-geocode responses are tiny. Keep a generous ceiling while
// preventing a compromised provider or network path from exhausting memory.
const GEOAPIFY_MAX_RESPONSE_BYTES = 256 * 1024;

// Reverse-geocode results per coordinate cell. Bounded LRU: an enrichment
// sweep over a large library touches many cells, and without a bound the
// cache grows for the life of the process. Hot cells (home, frequent trips)
// stay resident; the long tail recycles.
const locationCache = createBoundedMap(5000);

export async function enrichAssetLocation(asset, config) {
  if (!shouldReverseGeocode(asset, config)) {
    return asset;
  }

  const coordinates = getCoordinates(asset);
  const cacheKey = getCacheKey(coordinates, config.geocodingCoordinatePrecision);
  const cachedEnrichment = locationCache.get(cacheKey);
  const enrichment =
    cachedEnrichment ?? buildLocationEnrichment(await reverseGeocode(coordinates, config), coordinates);

  if (!enrichment) {
    return asset;
  }

  locationCache.set(cacheKey, enrichment);
  return applyLocationEnrichment(asset, enrichment);
}

export function applyLocationEnrichment(asset, enrichment) {
  if (!enrichment?.label) {
    return asset;
  }

  return {
    ...asset,
    locationLabel: enrichment.label || asset.locationLabel,
    locationEnrichment: enrichment,
    exifInfo: {
      ...asset.exifInfo,
      city: asset.exifInfo?.city || enrichment.city || null,
      state: asset.exifInfo?.state || enrichment.state || null,
      country: asset.exifInfo?.country || enrichment.country || null,
      countryCode: asset.exifInfo?.countryCode || enrichment.countryCode || null,
    },
  };
}

export function buildLocationEnrichment(location, coordinates, now = new Date()) {
  if (!location) {
    return null;
  }

  const label = formatLocationLabel(location);

  if (!label) {
    return null;
  }

  return {
    schemaVersion: 1,
    label,
    city: cleanText(location.city) || null,
    state: cleanText(location.state) || null,
    country: cleanText(location.country) || null,
    countryCode: cleanText(location.countryCode).toUpperCase() || null,
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    source: location.source || 'geoapify',
    createdAt: now.toISOString(),
  };
}

export function getLocationEnrichment(asset) {
  return asset?.locationEnrichment ?? null;
}

export function formatLocationLabel({ city, state, country, countryCode }) {
  const cleanCity = cleanText(city);
  const cleanState = cleanText(state);
  const cleanCountry = cleanText(country);
  const cleanCountryCode = cleanText(countryCode).toUpperCase();
  const countryLabel = isUnitedStates(cleanCountry, cleanCountryCode) ? 'USA' : cleanCountry;

  if (cleanCity && cleanState && countryLabel === 'USA') {
    return `${cleanCity}, ${cleanState}`;
  }

  if (cleanCity && countryLabel) {
    return `${cleanCity}, ${countryLabel}`;
  }

  if (cleanState && countryLabel) {
    return `${cleanState}, ${countryLabel}`;
  }

  return cleanCity || cleanState || countryLabel || cleanCountry || '';
}

// Neighborhood-level reverse geocode for the Insights home base card.
// Returns null (never throws) when no provider is configured or the lookup
// fails — callers fall back to the coarse city label.
export async function reverseGeocodeArea(coordinates, config) {
  if (config.geocodingProvider !== 'geoapify' || !config.geoapifyApiKey) {
    return null;
  }

  const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
  url.searchParams.set('lat', String(coordinates.latitude));
  url.searchParams.set('lon', String(coordinates.longitude));
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', config.geoapifyApiKey);

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PictariaServer/0.1',
      },
      maxResponseBytes: GEOAPIFY_MAX_RESPONSE_BYTES,
    }, config.geocodingTimeoutMs, 'Geoapify reverse geocoding');

    if (!response.ok) {
      console.warn(`Geoapify reverse geocoding failed with status ${response.status}.`);
      return null;
    }

    const result = (await response.json())?.results?.[0];
    if (!result) {
      return null;
    }
    const area = cleanText(result.suburb) || cleanText(result.neighbourhood)
      || cleanText(result.quarter) || cleanText(result.district);
    const city = cleanText(result.city);
    if (!area && !city) {
      return null;
    }
    return {
      area: area || null,
      city: city || null,
      label: area && city && area !== city ? `${area}, ${city}` : (area || city),
    };
  } catch (error) {
    console.warn('Geoapify reverse geocoding failed.', error instanceof Error ? error.message : error);
    return null;
  }
}

function shouldReverseGeocode(asset, config) {
  if (config.geocodingProvider !== 'geoapify' || !config.geoapifyApiKey) {
    return false;
  }

  if (hasCityOrState(asset)) {
    return false;
  }

  return Boolean(getCoordinates(asset));
}

function hasCityOrState(asset) {
  return Boolean(
    cleanText(asset?.city) ||
      cleanText(asset?.state) ||
      cleanText(asset?.exifInfo?.city) ||
      cleanText(asset?.exifInfo?.state),
  );
}

function getCoordinates(asset) {
  const latitude = Number(asset?.latitude ?? asset?.exifInfo?.latitude);
  const longitude = Number(asset?.longitude ?? asset?.exifInfo?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }

  return { latitude, longitude };
}

function getCacheKey(coordinates, precision = 3) {
  const safePrecision = Number.isInteger(precision) ? Math.min(5, Math.max(0, precision)) : 3;
  return `${coordinates.latitude.toFixed(safePrecision)},${coordinates.longitude.toFixed(safePrecision)}`;
}

async function reverseGeocode(coordinates, config) {
  const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
  url.searchParams.set('lat', String(coordinates.latitude));
  url.searchParams.set('lon', String(coordinates.longitude));
  url.searchParams.set('type', 'state');
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', config.geoapifyApiKey);

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PictariaServer/0.1',
      },
      maxResponseBytes: GEOAPIFY_MAX_RESPONSE_BYTES,
    }, config.geocodingTimeoutMs, 'Geoapify reverse geocoding');

    if (!response.ok) {
      console.warn(`Geoapify reverse geocoding failed with status ${response.status}.`);
      return null;
    }

    return parseGeoapifyLocation(await response.json());
  } catch (error) {
    console.warn('Geoapify reverse geocoding failed.', error instanceof Error ? error.message : error);
    return null;
  }
}

function parseGeoapifyLocation(body) {
  const result = body?.results?.[0] ?? body?.features?.[0]?.properties;

  if (!result) {
    return null;
  }

  return {
    city: cleanText(result.city),
    state: cleanText(result.state),
    country: cleanText(result.country),
    countryCode: cleanText(result.country_code),
    source: 'geoapify',
  };
}

function isUnitedStates(country, countryCode) {
  return countryCode === 'US' || UNITED_STATES_NAMES.has(String(country).trim().toLowerCase());
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
