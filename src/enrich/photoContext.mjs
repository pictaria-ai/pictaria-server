import {
  buildLocationEnrichment,
  getCacheKey,
  getCoordinates,
  locationCache,
  reverseGeocode,
} from '../ambient/geocoding.mjs';

// Resolves reverse geocoding for an asset using Geoapify and locationCache.
export async function resolveEnrichmentLocation({ asset, config = {} } = {}) {
  if (!asset || typeof asset !== 'object') return null;
  if (asset.locationEnrichment) return asset.locationEnrichment;

  const geoapifyApiKey = config.geoapifyApiKey
    || config.ambient?.geoapifyApiKey
    || process.env.GEOAPIFY_API_KEY
    || '';

  const coordinates = getCoordinates(asset);
  if (!coordinates) {
    return null;
  }

  const precision = config.geocodingCoordinatePrecision ?? config.ambient?.geocodingCoordinatePrecision ?? 3;
  const cacheKey = getCacheKey(coordinates, precision);
  const cached = locationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  if (geoapifyApiKey) {
    try {
      const geocodeConfig = {
        geocodingProvider: 'geoapify',
        geoapifyApiKey,
        geocodingTimeoutMs: config.geocodingTimeoutMs ?? config.ambient?.geocodingTimeoutMs ?? 5000,
      };
      const location = await reverseGeocode(coordinates, geocodeConfig);
      const enrichment = buildLocationEnrichment(location, coordinates);
      if (enrichment) {
        locationCache.set(cacheKey, enrichment);
        return enrichment;
      }
    } catch {
      // Tolerate geocoding network errors gracefully
    }
  }

  return null;
}

export function buildEnrichmentPhotoContext(options = {}) {
  const asset = options?.asset;
  const enrichedLocation = options?.enrichedLocation ?? null;
  if (!asset || typeof asset !== 'object') {
    return '';
  }

  const primaryPersonId = options?.primaryPersonId ?? null;
  const primaryPersonName = options?.primaryPersonName ?? null;
  const closeConnections = Array.isArray(options?.closeConnections) ? options.closeConnections : [];

  const lines = [];

  // 1. People / Faces
  const people = Array.isArray(asset.people) ? asset.people : [];
  const namedPeople = people
    .map((p) => (typeof p?.name === 'string' ? p.name.trim() : ''))
    .filter(Boolean);

  const closeConnectionsMap = new Map(
    closeConnections.map((c) => [c.personId, c]),
  );
  const closeConnectionsByName = new Map(
    closeConnections.map((c) => [(c.name || '').toLowerCase(), c]),
  );

  if (namedPeople.length > 0) {
    const formattedPeople = [];
    let hasPrimaryUser = false;
    const closeFound = [];

    for (const p of people) {
      if (!p?.name) continue;
      const name = p.name.trim();
      if (!name) continue;
      const isPrimary = Boolean(
        (primaryPersonId && p.id === primaryPersonId) ||
        (primaryPersonName && name.toLowerCase() === primaryPersonName.toLowerCase())
      );

      if (isPrimary) {
        hasPrimaryUser = true;
        formattedPeople.push(`${name} (primary user / "Me")`);
      } else {
        const conn = closeConnectionsMap.get(p.id) || closeConnectionsByName.get(name.toLowerCase());
        if (conn && conn.count >= 2) {
          closeFound.push(name);
          formattedPeople.push(`${name} (close companion · ${conn.count} photos with Me)`);
        } else {
          formattedPeople.push(name);
        }
      }
    }

    const uniqueFormatted = [...new Set(formattedPeople)];
    const faceCountNote = people.length > uniqueFormatted.length
      ? ` (${people.length} faces detected)`
      : ` (${people.length} person${people.length === 1 ? '' : 's'})`;
    lines.push(`- People identified: ${uniqueFormatted.join(', ')}${faceCountNote}`);
    if (hasPrimaryUser) {
      lines.push('- Relationship context: features the primary user ("Me")');
    } else if (closeFound.length > 0) {
      lines.push(`- Relationship context: features close companions of the primary user (${closeFound.join(', ')})`);
    }
  } else if (people.length > 0) {
    lines.push(`- People: ${people.length} unidentified face${people.length === 1 ? '' : 's'} detected`);
  } else {
    lines.push('- People: none detected by face recognition');
  }

  // 2. Date and Time
  const rawDate = asset.exifInfo?.dateTimeOriginal || asset.fileCreatedAt || asset.localDateTime;
  if (rawDate) {
    const formattedDate = formatDateContext(rawDate);
    if (formattedDate) {
      lines.push(`- Date & time: ${formattedDate}`);
    }
  }

  // 3. Location (Geoapify or EXIF)
  const locationLabel = enrichedLocation?.label
    || asset.locationLabel
    || formatExifLocation(asset.exifInfo);
  const coords = getAssetCoordinates(asset);
  if (locationLabel) {
    const coordsStr = coords ? ` (coordinates: ${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)})` : '';
    lines.push(`- Location: ${locationLabel}${coordsStr}`);
  } else if (coords) {
    lines.push(`- Location coordinates: ${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`);
  }

  // 4. Camera and photographic settings
  const camera = formatCameraDetails(asset.exifInfo);
  if (camera) {
    lines.push(`- Camera: ${camera}`);
  }

  // 5. Immich machine learning signals (CLIP descriptions, smart search tags, detected objects)
  const smartInfo = asset.smartInfo;
  if (smartInfo && typeof smartInfo === 'object') {
    if (typeof smartInfo.clipDescription === 'string' && smartInfo.clipDescription.trim()) {
      lines.push(`- Immich CLIP scene description: ${smartInfo.clipDescription.trim()}`);
    }
    const mlTags = Array.isArray(smartInfo.tags) ? smartInfo.tags.filter(Boolean) : [];
    if (mlTags.length > 0) {
      lines.push(`- Immich smart tags: ${mlTags.slice(0, 10).join(', ')}`);
    }
    const objects = Array.isArray(smartInfo.objects) ? smartInfo.objects.filter(Boolean) : [];
    if (objects.length > 0) {
      lines.push(`- Detected objects: ${objects.slice(0, 10).join(', ')}`);
    }
  }

  // 6. Existing user/EXIF description
  const description = cleanText(asset.exifInfo?.description || asset.description);
  if (description) {
    lines.push(`- Existing description: "${description}"`);
  }

  return lines.join('\n');
}

function formatDateContext(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const month = monthNames[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;

  // Season (Northern hemisphere default)
  const monthIdx = d.getMonth();
  let season = 'winter';
  if (monthIdx >= 2 && monthIdx <= 4) season = 'spring';
  else if (monthIdx >= 5 && monthIdx <= 7) season = 'summer';
  else if (monthIdx >= 8 && monthIdx <= 10) season = 'autumn';

  // Time of day
  const hour24 = d.getHours();
  let timeOfDay = 'night';
  if (hour24 >= 5 && hour24 < 12) timeOfDay = 'morning';
  else if (hour24 >= 12 && hour24 < 17) timeOfDay = 'afternoon';
  else if (hour24 >= 17 && hour24 < 21) timeOfDay = 'evening';

  return `${month} ${day}, ${year} at ${hours}:${minutes} ${ampm} (${season}, ${timeOfDay})`;
}

function formatExifLocation(exif) {
  if (!exif || typeof exif !== 'object') return null;
  const parts = [exif.city, exif.state, exif.country].filter(Boolean).map(cleanText).filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function getAssetCoordinates(asset) {
  const lat = Number(asset?.exifInfo?.latitude ?? asset?.latitude);
  const lon = Number(asset?.exifInfo?.longitude ?? asset?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
    return { latitude: lat, longitude: lon };
  }
  return null;
}

function formatCameraDetails(exif) {
  if (!exif || typeof exif !== 'object') return null;
  const parts = [];
  const make = cleanText(exif.make);
  const model = cleanText(exif.model);
  if (model) {
    parts.push(make && !model.toLowerCase().includes(make.toLowerCase()) ? `${make} ${model}` : model);
  } else if (make) {
    parts.push(make);
  }

  const lens = cleanText(exif.lensModel);
  if (lens && lens !== model) {
    parts.push(lens);
  }

  const settings = [];
  if (exif.focalLength) settings.push(`${exif.focalLength}mm`);
  if (exif.fNumber) settings.push(`f/${exif.fNumber}`);
  if (exif.exposureTime) settings.push(formatExposureTime(exif.exposureTime));
  if (exif.iso) settings.push(`ISO ${exif.iso}`);

  if (settings.length > 0) {
    parts.push(`(${settings.join(', ')})`);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

function formatExposureTime(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return String(value);
  if (num >= 1) return `${num}s`;
  const reciprocal = Math.round(1 / num);
  return `1/${reciprocal}s`;
}

function cleanText(val) {
  return typeof val === 'string' ? val.trim() : '';
}
