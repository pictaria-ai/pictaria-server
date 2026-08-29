export function getDisplayLocation(location) {
  const city = clean(location?.city);
  const state = clean(location?.state);
  const country = clean(location?.country);

  return {
    compactLocation: buildCompactLocation(city, state, country),
    fullLocation: buildFullLocation(city, state, country),
  };
}

export function hasSpecificLocationParts(location) {
  return Boolean(clean(location?.city) || clean(location?.state));
}

function buildCompactLocation(city, state, country) {
  if (isUnitedStates(country)) {
    const stateLabel = formatUsState(state);

    if (city && stateLabel) {
      return `${city}, ${stateLabel}`;
    }

    return city || stateLabel || country;
  }

  if (city && state && country) {
    const parentDisplayPlace = getParentDisplayPlace(city, state, country);

    if (parentDisplayPlace) {
      return `${parentDisplayPlace}, ${country}`;
    }

    return `${city}, ${country}`;
  }

  if (city && country) {
    return `${city}, ${country}`;
  }

  if (state && country) {
    return `${state}, ${country}`;
  }

  return city || state || country;
}

function buildFullLocation(city, state, country) {
  const parts = [city, state, country].filter(Boolean);
  const deduped = [];

  for (const part of parts) {
    if (!deduped.some((existing) => norm(existing) === norm(part))) {
      deduped.push(part);
    }
  }

  return deduped.length ? deduped.join(', ') : null;
}

function getParentDisplayPlace(city, state, country) {
  if (norm(city) === norm(state)) {
    return null;
  }

  const normalizedParent = `${norm(state)}|${norm(country)}`;

  if (PARENT_DISPLAY_PLACE_OVERRIDES[normalizedParent]) {
    return PARENT_DISPLAY_PLACE_OVERRIDES[normalizedParent];
  }

  return MAJOR_PARENT_DISPLAY_PLACES.has(normalizedParent) ? state : null;
}

function isUnitedStates(country) {
  if (!country) {
    return false;
  }

  return UNITED_STATES_NAMES.has(norm(country));
}

function formatUsState(state) {
  if (!state) {
    return null;
  }

  return US_STATE_NAMES[norm(state)] ?? state;
}

function clean(value) {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return cleaned || null;
}

function norm(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

const UNITED_STATES_NAMES = new Set([
  'united states',
  'united states of america',
  'usa',
  'us',
]);

const MAJOR_PARENT_DISPLAY_PLACES = new Set([
  'tokyo|japan',
  'kyoto|japan',
  'osaka|japan',
  'mexico city|mexico',
  'ciudad de mexico|mexico',
  'cdmx|mexico',
  'london|united kingdom',
  'paris|france',
  'madrid|spain',
  'barcelona|spain',
  'rome|italy',
  'roma|italy',
  'berlin|germany',
  'amsterdam|netherlands',
  'seoul|south korea',
  'bangkok|thailand',
  'istanbul|turkey',
  'buenos aires|argentina',
  'singapore|singapore',
  'hong kong|hong kong',
]);

const PARENT_DISPLAY_PLACE_OVERRIDES = {
  'ile-de-france|france': 'Paris',
};

const US_STATE_NAMES = {
  al: 'Alabama',
  alabama: 'Alabama',
  ak: 'Alaska',
  alaska: 'Alaska',
  az: 'Arizona',
  arizona: 'Arizona',
  ar: 'Arkansas',
  arkansas: 'Arkansas',
  ca: 'California',
  california: 'California',
  co: 'Colorado',
  colorado: 'Colorado',
  ct: 'Connecticut',
  connecticut: 'Connecticut',
  de: 'Delaware',
  delaware: 'Delaware',
  dc: 'District of Columbia',
  'district of columbia': 'District of Columbia',
  fl: 'Florida',
  florida: 'Florida',
  ga: 'Georgia',
  georgia: 'Georgia',
  hi: 'Hawaii',
  hawaii: 'Hawaii',
  id: 'Idaho',
  idaho: 'Idaho',
  il: 'Illinois',
  illinois: 'Illinois',
  in: 'Indiana',
  indiana: 'Indiana',
  ia: 'Iowa',
  iowa: 'Iowa',
  ks: 'Kansas',
  kansas: 'Kansas',
  ky: 'Kentucky',
  kentucky: 'Kentucky',
  la: 'Louisiana',
  louisiana: 'Louisiana',
  me: 'Maine',
  maine: 'Maine',
  md: 'Maryland',
  maryland: 'Maryland',
  ma: 'Massachusetts',
  massachusetts: 'Massachusetts',
  mi: 'Michigan',
  michigan: 'Michigan',
  mn: 'Minnesota',
  minnesota: 'Minnesota',
  ms: 'Mississippi',
  mississippi: 'Mississippi',
  mo: 'Missouri',
  missouri: 'Missouri',
  mt: 'Montana',
  montana: 'Montana',
  ne: 'Nebraska',
  nebraska: 'Nebraska',
  nv: 'Nevada',
  nevada: 'Nevada',
  nh: 'New Hampshire',
  'new hampshire': 'New Hampshire',
  nj: 'New Jersey',
  'new jersey': 'New Jersey',
  nm: 'New Mexico',
  'new mexico': 'New Mexico',
  ny: 'New York',
  'new york': 'New York',
  nc: 'North Carolina',
  'north carolina': 'North Carolina',
  nd: 'North Dakota',
  'north dakota': 'North Dakota',
  oh: 'Ohio',
  ohio: 'Ohio',
  ok: 'Oklahoma',
  oklahoma: 'Oklahoma',
  or: 'Oregon',
  oregon: 'Oregon',
  pa: 'Pennsylvania',
  pennsylvania: 'Pennsylvania',
  ri: 'Rhode Island',
  'rhode island': 'Rhode Island',
  sc: 'South Carolina',
  'south carolina': 'South Carolina',
  sd: 'South Dakota',
  'south dakota': 'South Dakota',
  tn: 'Tennessee',
  tennessee: 'Tennessee',
  tx: 'Texas',
  texas: 'Texas',
  ut: 'Utah',
  utah: 'Utah',
  vt: 'Vermont',
  vermont: 'Vermont',
  va: 'Virginia',
  virginia: 'Virginia',
  wa: 'Washington',
  washington: 'Washington',
  wv: 'West Virginia',
  'west virginia': 'West Virginia',
  wi: 'Wisconsin',
  wisconsin: 'Wisconsin',
  wy: 'Wyoming',
  wyoming: 'Wyoming',
};
