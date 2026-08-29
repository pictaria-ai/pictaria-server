import { getDisplayLocation, hasSpecificLocationParts } from '../ambient/locationDisplay.mjs';

export function buildPhotoAnswers(asset) {
  return {
    where: buildWhereAnswer(asset),
    when: buildWhenAnswer(asset),
  };
}

export function buildWhereAnswer(asset) {
  const rawLocation = {
    city: asset?.city || asset?.exifInfo?.city,
    state: asset?.state || asset?.exifInfo?.state,
    country: asset?.country || asset?.exifInfo?.country,
  };
  const displayLocation = getDisplayLocation(rawLocation).compactLocation;
  const place = hasSpecificLocationParts(rawLocation)
    ? displayLocation
    : cleanText(asset?.locationLabel) || displayLocation;

  if (place) {
    return {
      text: `This was taken in ${place}.`,
      speakText: `This was taken in ${place}.`,
      confidence: rawLocation.country || rawLocation.state || asset?.locationLabel ? 'known' : 'partial',
    };
  }

  return missingMetadataAnswer();
}

export function buildWhenAnswer(asset) {
  const value = asset?.exifInfo?.dateTimeOriginal || asset?.localDateTime;
  const date = parseDateParts(value);

  if (!date) {
    return missingMetadataAnswer();
  }

  const formattedDate = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));

  return {
    text: `This was taken on ${formattedDate}.`,
    speakText: `This was taken on ${formattedDate}.`,
    confidence: 'known',
  };
}

export function formatPlace({ city, state, country }) {
  return getDisplayLocation({ city, state, country }).compactLocation || '';
}

export function parseDateParts(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const match = value.match(/^(\d{4})[-:](\d{2})[-:](\d{2})/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (!isValidDateParts(year, month, day)) {
    return null;
  }

  return { year, month, day };
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function missingMetadataAnswer() {
  return {
    text: "This photo doesn't have that metadata.",
    speakText: "This photo doesn't have that metadata.",
    confidence: 'missing',
  };
}
