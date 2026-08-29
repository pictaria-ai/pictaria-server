import { fetchWithTimeout, RequestTimeoutError } from '../fetchWithTimeout.mjs';
import { createBoundedMap } from '../boundedMap.mjs';

export const DEFAULT_WEATHER_FORECAST_DAY = 'today';
export const WEATHER_CACHE_TTL_SECONDS = 15 * 60;
export const GEOCODING_CACHE_TTL_SECONDS = 24 * 60 * 60;

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
// Bounded LRU: a household sees a handful of locations, but automated
// queries or tests must not grow these for the life of the process.
const weatherCache = createBoundedMap(200);
const geocodingCache = createBoundedMap(500);
const US_STATE_ABBREVIATIONS = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
};

export class WeatherError extends Error {
  constructor(message, status = 503, code = 'weather_unavailable') {
    super(message);
    this.name = 'WeatherError';
    this.status = status;
    this.code = code;
  }
}

export async function getWeather(locationInput, options = {}) {
  const location = await resolveWeatherLocation(locationInput, options);
  const forecastDay = normalizeForecastDay(options.forecastDay);
  const cacheKey = `weather:${location.id}:${forecastDay}`;
  const cached = weatherCache.get(cacheKey);
  const now = options.now ?? new Date();

  if (cached && !isExpired(cached, now)) {
    return withCacheStatus(cached.value, 'hit');
  }

  try {
    const forecast = await fetchOpenMeteoForecast(location, options);
    const normalized = normalizeOpenMeteoResponse(location, forecast, now, forecastDay);
    weatherCache.set(cacheKey, {
      storedAt: now.getTime(),
      value: normalized,
    });

    return withCacheStatus(normalized, 'miss');
  } catch (error) {
    if (cached) {
      console.warn('[Pictaria] Weather request failed; returning stale cached forecast.', summarizeWeatherError(error));
      return withCacheStatus(cached.value, 'stale');
    }

    if (error instanceof WeatherError) {
      throw error;
    }

    if (error instanceof RequestTimeoutError) {
      throw new WeatherError(error.message, 504);
    }

    throw new WeatherError('Weather is temporarily unavailable.');
  }
}

export async function resolveWeatherLocation(locationInput, options = {}) {
  const normalizedLocationInput = normalizeWeatherLocationInput(locationInput);

  if (!normalizedLocationInput) {
    throw new WeatherError(
      'No weather location configured. Pass ?location= or set WEATHER_DEFAULT_LOCATION.',
      400,
      'weather_location_required',
    );
  }

  return geocodeWeatherLocation(normalizedLocationInput, options);
}

export function normalizeForecastDay(value = DEFAULT_WEATHER_FORECAST_DAY) {
  const forecastDay = String(value || DEFAULT_WEATHER_FORECAST_DAY).trim().toLowerCase();

  if (forecastDay === 'today' || forecastDay === 'tomorrow') {
    return forecastDay;
  }

  throw new WeatherError(`Unsupported weather forecast day: ${forecastDay}.`, 400, 'invalid_weather_forecast_day');
}

export async function fetchOpenMeteoForecast(location, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = buildOpenMeteoForecastUrl(location);
  const response = await fetchWithTimeout(
    url,
    { fetchImpl, headers: { Accept: 'application/json' } },
    timeoutMs,
    'Open-Meteo forecast',
  );

  if (!response.ok) {
    throw new WeatherError(`Open-Meteo request failed with status ${response.status}.`, response.status);
  }

  return response.json();
}

export async function fetchOpenMeteoGeocoding(locationQuery, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = buildOpenMeteoGeocodingUrl(locationQuery);
  const response = await fetchWithTimeout(
    url,
    { fetchImpl, headers: { Accept: 'application/json' } },
    timeoutMs,
    'Open-Meteo geocoding',
  );

  if (!response.ok) {
    throw new WeatherError(`Open-Meteo geocoding request failed with status ${response.status}.`, response.status);
  }

  return response.json();
}

export function buildOpenMeteoForecastUrl(location) {
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set('current', 'temperature_2m,weather_code,precipitation,rain,snowfall');
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,rain_sum,snowfall_sum',
  );
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '2');
  return url.toString();
}

export function buildOpenMeteoGeocodingUrl(locationQuery) {
  const url = new URL(OPEN_METEO_GEOCODING_URL);
  url.searchParams.set('name', normalizeWeatherLocationInput(locationQuery));
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  if (isUsZipCode(locationQuery)) {
    url.searchParams.set('countryCode', 'US');
  }

  return url.toString();
}

export function normalizeOpenMeteoResponse(location, response, now = new Date(), forecastDay = DEFAULT_WEATHER_FORECAST_DAY) {
  const normalizedForecastDay = normalizeForecastDay(forecastDay);
  const dayIndex = normalizedForecastDay === 'tomorrow' ? 1 : 0;
  const includeCurrent = normalizedForecastDay === 'today';
  const currentCode = numberOrNull(response?.current?.weather_code);
  const dayCode = numberOrNull(response?.daily?.weather_code?.[dayIndex]);
  const currentTemperatureC = includeCurrent ? roundNullable(response?.current?.temperature_2m) : null;
  const highC = roundNullable(response?.daily?.temperature_2m_max?.[dayIndex]);
  const lowC = roundNullable(response?.daily?.temperature_2m_min?.[dayIndex]);
  const precipitationProbabilityMaxPct = roundNullable(response?.daily?.precipitation_probability_max?.[dayIndex]);
  const precipitationSumInches = roundInchesNullable(response?.daily?.precipitation_sum?.[dayIndex]);
  const rainSumInches = roundInchesNullable(response?.daily?.rain_sum?.[dayIndex]);
  const snowfallSumInches = roundInchesNullable(response?.daily?.snowfall_sum?.[dayIndex]);
  const weather = {
    forecastDay: normalizedForecastDay,
    locationId: location.id,
    locationLabel: location.displayLabel,
    locationSpeechLabel: location.speechLabel ?? location.displayLabel,
    provider: 'open-meteo',
    observedAt: includeCurrent ? stringOrNull(response?.current?.time) : null,
    generatedAt: now.toISOString(),
    current: {
      temperatureC: currentTemperatureC,
      conditionCode: includeCurrent ? currentCode : null,
      conditionLabel: includeCurrent ? mapOpenMeteoWeatherCode(currentCode) : null,
      precipitationInches: includeCurrent ? roundInchesNullable(response?.current?.precipitation) : null,
      rainInches: includeCurrent ? roundInchesNullable(response?.current?.rain) : null,
      snowfallInches: includeCurrent ? roundInchesNullable(response?.current?.snowfall) : null,
    },
    today: {
      date: stringOrNull(response?.daily?.time?.[dayIndex]) ?? '',
      highC,
      lowC,
      conditionCode: dayCode,
      conditionLabel: mapOpenMeteoWeatherCode(dayCode ?? (includeCurrent ? currentCode : null)),
      precipitationProbabilityMaxPct,
      precipitationSumInches,
      rainSumInches,
      snowfallSumInches,
    },
    flags: buildWeatherFlags({
      highC,
      lowC,
      precipitationProbabilityMaxPct,
      precipitationSumInches,
      rainSumInches,
      snowfallSumInches,
    }),
  };

  weather.spokenSummary = buildSpokenSummary(weather);
  weather.displaySummary = buildDisplaySummary(weather);

  return weather;
}

export function mapOpenMeteoWeatherCode(code) {
  if (code == null) {
    return null;
  }

  const labels = {
    0: 'clear sky',
    1: 'mostly clear',
    2: 'partly cloudy',
    3: 'overcast',
    45: 'fog',
    48: 'depositing rime fog',
    51: 'light drizzle',
    53: 'moderate drizzle',
    55: 'dense drizzle',
    56: 'light freezing drizzle',
    57: 'dense freezing drizzle',
    61: 'slight rain',
    63: 'moderate rain',
    65: 'heavy rain',
    66: 'light freezing rain',
    67: 'heavy freezing rain',
    71: 'slight snow',
    73: 'moderate snow',
    75: 'heavy snow',
    77: 'snow grains',
    80: 'slight rain showers',
    81: 'moderate rain showers',
    82: 'violent rain showers',
    85: 'slight snow showers',
    86: 'heavy snow showers',
    95: 'thunderstorm',
    96: 'thunderstorm with slight hail',
    99: 'thunderstorm with heavy hail',
  };

  return labels[code] ?? 'unknown conditions';
}

export function buildSpokenSummary(weather) {
  const tempPart =
    weather.forecastDay === 'tomorrow'
      ? `Here is tomorrow's weather for ${getWeatherSpeechLocationLabel(weather)}.`
      : weather.current.temperatureC != null
        ? `In ${getWeatherSpeechLocationLabel(weather)}, it is currently ${weather.current.temperatureC} degrees Celsius.`
        : `Here is today's weather for ${getWeatherSpeechLocationLabel(weather)}.`;
  const highLowPart =
    weather.today.highC != null && weather.today.lowC != null
      ? `${weather.forecastDay === 'tomorrow' ? "Tomorrow's" : "Today's"} high is ${weather.today.highC} and the low is ${weather.today.lowC}.`
      : '';
  const conditionPart =
    weather.today.conditionLabel != null ? `It should be ${weather.today.conditionLabel}` : '';
  const precip = weather.today.precipitationProbabilityMaxPct;
  let forecastPart = '';

  if (weather.flags.snowLikelyToday) {
    forecastPart =
      precip != null
        ? joinConditionAndPrecip(conditionPart, `with a ${precip} percent chance of precipitation and possible snow`)
        : joinConditionAndPrecip(conditionPart, 'with possible snow');
  } else if (weather.flags.rainLikelyToday) {
    forecastPart =
      precip != null
        ? joinConditionAndPrecip(conditionPart, `with a ${precip} percent chance of rain`)
        : joinConditionAndPrecip(conditionPart, 'with possible rain');
  } else if (precip != null && precip > 0) {
    forecastPart = joinConditionAndPrecip(conditionPart, `with a ${precip} percent chance of precipitation`);
  } else {
    const periodLabel = weather.forecastDay === 'tomorrow' ? 'tomorrow' : 'today';
    forecastPart = conditionPart
      ? `${conditionPart}. No meaningful rain is expected ${periodLabel}.`
      : `No meaningful rain is expected ${periodLabel}.`;
  }

  return [tempPart, highLowPart, forecastPart]
    .filter(Boolean)
    .join(' ');
}

export function buildDisplaySummary(weather) {
  const dayLabel = weather.forecastDay === 'tomorrow' ? 'tomorrow' : 'today';
  const hasTemperature =
    weather.current.temperatureC != null ||
    weather.today.highC != null ||
    weather.today.lowC != null;

  if (!hasTemperature) {
    return `${weather.locationLabel}: Weather unavailable.`;
  }

  return [
    weather.forecastDay === 'today' && weather.current.temperatureC != null
      ? `${weather.locationLabel}: ${weather.current.temperatureC}°C now.`
      : `${weather.locationLabel} ${dayLabel}:`,
    weather.today.highC != null && weather.today.lowC != null
      ? `High ${weather.today.highC}°, low ${weather.today.lowC}°.`
      : '',
    weather.today.conditionLabel ? `${capitalize(weather.today.conditionLabel)}.` : '',
    weather.today.precipitationProbabilityMaxPct != null
      ? `${weather.today.precipitationProbabilityMaxPct}% chance of precipitation.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildWeatherFlags({
  highC,
  lowC,
  precipitationProbabilityMaxPct,
  precipitationSumInches,
  rainSumInches,
  snowfallSumInches,
}) {
  const rainLikelyToday = (precipitationProbabilityMaxPct ?? 0) >= 40 || (rainSumInches ?? 0) >= 0.03;
  const snowLikelyToday = (snowfallSumInches ?? 0) >= 0.1;
  const precipitationLikelyToday =
    rainLikelyToday ||
    snowLikelyToday ||
    (precipitationProbabilityMaxPct ?? 0) >= 40 ||
    (precipitationSumInches ?? 0) >= 0.03;

  return {
    rainLikelyToday,
    snowLikelyToday,
    precipitationLikelyToday,
    freezingToday: lowC != null && lowC <= 0,
    hotToday: highC != null && highC >= 32,
  };
}

function withCacheStatus(weather, status) {
  return {
    ...weather,
    generatedAt: new Date().toISOString(),
    cache: {
      status,
      maxAgeSeconds: WEATHER_CACHE_TTL_SECONDS,
    },
  };
}

function isExpired(cached, now) {
  return now.getTime() - cached.storedAt >= (cached.ttlSeconds ?? WEATHER_CACHE_TTL_SECONDS) * 1000;
}

async function geocodeWeatherLocation(locationQuery, options) {
  const normalizedLocationQuery = normalizeWeatherLocationInput(locationQuery);
  const cacheKey = `geocoding:${normalizedLocationQuery.toLowerCase()}`;
  const now = options.now ?? new Date();
  const cached = geocodingCache.get(cacheKey);

  if (cached && !isExpired(cached, now)) {
    return cached.value;
  }

  const geocodingResponse = await fetchOpenMeteoGeocoding(normalizedLocationQuery, options);
  let result = firstGeocodingResult(geocodingResponse);

  if (!result && normalizedLocationQuery.includes(',')) {
    const fallbackQuery = normalizedLocationQuery.split(',')[0]?.trim();
    if (fallbackQuery) {
      result = firstGeocodingResult(await fetchOpenMeteoGeocoding(fallbackQuery, options));
    }
  }

  if (!result) {
    throw new WeatherError(`Unsupported weather location: ${normalizedLocationQuery}.`, 400, 'invalid_weather_location');
  }

  const location = normalizeGeocodingResult(normalizedLocationQuery, result);
  geocodingCache.set(cacheKey, {
    storedAt: now.getTime(),
    ttlSeconds: GEOCODING_CACHE_TTL_SECONDS,
    value: location,
  });

  return location;
}

function normalizeWeatherLocationInput(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function firstGeocodingResult(response) {
  return Array.isArray(response?.results) ? response.results[0] : null;
}

function normalizeGeocodingResult(locationQuery, result) {
  const latitude = numberOrNull(result?.latitude);
  const longitude = numberOrNull(result?.longitude);

  if (latitude == null || longitude == null) {
    throw new WeatherError(`Weather location did not include coordinates: ${locationQuery}.`, 400, 'invalid_weather_location');
  }

  return {
    id: `custom:${locationQuery.toLowerCase()}`,
    label: locationQuery,
    displayLabel: formatGeocodingDisplayLabel(result, locationQuery),
    speechLabel: stringOrNull(result?.name) ?? locationQuery,
    latitude,
    longitude,
    timezone: stringOrNull(result?.timezone) ?? 'auto',
  };
}

function formatGeocodingDisplayLabel(result, fallback) {
  const name = stringOrNull(result?.name);
  const countryCode = stringOrNull(result?.country_code);
  const country = stringOrNull(result?.country);

  if (!name) {
    return fallback;
  }

  if (countryCode === 'US') {
    const state = formatUsState(result?.admin1);
    return [name, state].filter(Boolean).join(', ') || fallback;
  }

  return [name, country].filter(Boolean).join(', ') || fallback;
}

function formatUsState(value) {
  const state = stringOrNull(value);
  if (!state) {
    return null;
  }

  return US_STATE_ABBREVIATIONS[state.toLowerCase()] ?? state;
}

function getWeatherSpeechLocationLabel(weather) {
  return weather.locationSpeechLabel || weather.locationLabel;
}

function isUsZipCode(value) {
  return /^\d{5}(?:-\d{4})?$/.test(String(value || '').trim());
}

function roundNullable(value) {
  const number = numberOrNull(value);
  return number == null ? null : Math.round(number);
}

function roundInchesNullable(value) {
  const number = numberOrNull(value);
  return number == null ? null : Math.round(number * 100) / 100;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function joinConditionAndPrecip(conditionPart, precipPart) {
  return conditionPart ? `${conditionPart}, ${precipPart}.` : `${capitalize(precipPart)}.`;
}

function summarizeWeatherError(error) {
  return error instanceof Error ? error.message : String(error);
}
