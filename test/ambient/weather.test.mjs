import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDisplaySummary,
  buildOpenMeteoGeocodingUrl,
  buildOpenMeteoForecastUrl,
  buildSpokenSummary,
  mapOpenMeteoWeatherCode,
  normalizeOpenMeteoResponse,
  resolveWeatherLocation,
  WeatherError,
} from '../../src/ambient/weather.mjs';

const JACKSON_LOCATION = {
  id: 'jackson',
  label: 'Jackson',
  displayLabel: 'Jackson',
  latitude: 43.4799,
  longitude: -110.7624,
  timezone: 'America/Denver',
};

const SAN_FRANCISCO_LOCATION = {
  id: 'san_francisco',
  label: 'San Francisco',
  displayLabel: 'San Francisco',
  latitude: 37.7749,
  longitude: -122.4194,
  timezone: 'America/Los_Angeles',
};

const JACKSON_FORECAST = {
  current: {
    time: '2026-06-29T11:00',
    temperature_2m: 16.4,
    weather_code: 2,
    precipitation: 0,
    rain: 0,
    snowfall: 0,
  },
  daily: {
    time: ['2026-06-29', '2026-06-30'],
    weather_code: [2, 3],
    temperature_2m_max: [23.4, 18.2],
    temperature_2m_min: [6.1, 4.9],
    precipitation_probability_max: [20, 40],
    precipitation_sum: [0.01, 0.03],
    rain_sum: [0.01, 0.03],
    snowfall_sum: [0, 0],
  },
};

test('maps Open-Meteo weather codes to readable labels', () => {
  assert.equal(mapOpenMeteoWeatherCode(0), 'clear sky');
  assert.equal(mapOpenMeteoWeatherCode(63), 'moderate rain');
  assert.equal(mapOpenMeteoWeatherCode(86), 'heavy snow showers');
  assert.equal(mapOpenMeteoWeatherCode(12345), 'unknown conditions');
  assert.equal(mapOpenMeteoWeatherCode(null), null);
});

test('normalizes Open-Meteo current and daily forecast fields', () => {
  const weather = normalizeOpenMeteoResponse(
    JACKSON_LOCATION,
    JACKSON_FORECAST,
    new Date('2026-06-29T17:23:04.000Z'),
  );

  assert.deepEqual(weather.current, {
    temperatureC: 16,
    conditionCode: 2,
    conditionLabel: 'partly cloudy',
    precipitationInches: 0,
    rainInches: 0,
    snowfallInches: 0,
  });
  assert.deepEqual(weather.today, {
    date: '2026-06-29',
    highC: 23,
    lowC: 6,
    conditionCode: 2,
    conditionLabel: 'partly cloudy',
    precipitationProbabilityMaxPct: 20,
    precipitationSumInches: 0.01,
    rainSumInches: 0.01,
    snowfallSumInches: 0,
  });
  assert.equal(weather.spokenSummary, "In Jackson, it is currently 16 degrees Celsius. Today's high is 23 and the low is 6. It should be partly cloudy, with a 20 percent chance of precipitation.");
  assert.equal(weather.displaySummary, 'Jackson: 16°C now. High 23°, low 6°. Partly cloudy. 20% chance of precipitation.');
});

test('normalizes tomorrow forecast without current conditions', () => {
  const weather = normalizeOpenMeteoResponse(
    JACKSON_LOCATION,
    JACKSON_FORECAST,
    new Date('2026-06-29T17:23:04.000Z'),
    'tomorrow',
  );

  assert.equal(weather.forecastDay, 'tomorrow');
  assert.equal(weather.observedAt, null);
  assert.deepEqual(weather.current, {
    temperatureC: null,
    conditionCode: null,
    conditionLabel: null,
    precipitationInches: null,
    rainInches: null,
    snowfallInches: null,
  });
  assert.equal(weather.today.date, '2026-06-30');
  assert.equal(weather.today.highC, 18);
  assert.equal(weather.today.lowC, 5);
  assert.equal(weather.spokenSummary, "Here is tomorrow's weather for Jackson. Tomorrow's high is 18 and the low is 5. It should be overcast, with a 40 percent chance of rain.");
  assert.equal(weather.displaySummary, 'Jackson tomorrow: High 18°, low 5°. Overcast. 40% chance of precipitation.');
});

test('flags likely precipitation using simple thresholds', () => {
  const rainyWeather = normalizeOpenMeteoResponse(SAN_FRANCISCO_LOCATION, {
    current: { temperature_2m: 14, weather_code: 61 },
    daily: {
      time: ['2026-06-29'],
      weather_code: [61],
      temperature_2m_max: [18],
      temperature_2m_min: [12],
      precipitation_probability_max: [45],
      precipitation_sum: [0.04],
      rain_sum: [0.04],
      snowfall_sum: [0],
    },
  });

  assert.equal(rainyWeather.flags.rainLikelyToday, true);
  assert.equal(rainyWeather.flags.precipitationLikelyToday, true);
  assert.match(rainyWeather.spokenSummary, /45 percent chance of rain/);
});

test('builds Open-Meteo forecast URL with expected provider parameters', () => {
  const url = new URL(buildOpenMeteoForecastUrl(JACKSON_LOCATION));

  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '43.4799');
  assert.equal(url.searchParams.get('longitude'), '-110.7624');
  assert.equal(url.searchParams.get('temperature_unit'), 'celsius');
  assert.equal(url.searchParams.get('precipitation_unit'), 'inch');
  assert.equal(url.searchParams.get('forecast_days'), '2');
});

test('builds Open-Meteo geocoding URL for US ZIP codes', () => {
  const url = new URL(buildOpenMeteoGeocodingUrl('94110'));

  assert.equal(url.origin + url.pathname, 'https://geocoding-api.open-meteo.com/v1/search');
  assert.equal(url.searchParams.get('name'), '94110');
  assert.equal(url.searchParams.get('count'), '1');
  assert.equal(url.searchParams.get('countryCode'), 'US');
});

test('resolves dynamic weather locations through Open-Meteo geocoding', async () => {
  const location = await resolveWeatherLocation('94110', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            name: 'San Francisco',
            latitude: 37.77493,
            longitude: -122.41942,
            admin1: 'California',
            country: 'United States',
            country_code: 'US',
            timezone: 'America/Los_Angeles',
          },
        ],
      }),
    }),
    now: new Date('2026-06-29T17:23:04.000Z'),
  });

  assert.equal(location.id, 'custom:94110');
  assert.equal(location.displayLabel, 'San Francisco, CA');
  assert.equal(location.speechLabel, 'San Francisco');
  assert.equal(location.latitude, 37.77493);
  assert.equal(location.longitude, -122.41942);
  assert.equal(location.timezone, 'America/Los_Angeles');
});

test('falls back to city name when comma-form geocoding has no exact result', async () => {
  const requestedNames = [];
  const location = await resolveWeatherLocation('San Francisco, CA', {
    fetchImpl: async (url) => {
      requestedNames.push(new URL(url).searchParams.get('name'));
      return {
        ok: true,
        json: async () => requestedNames.length === 1
          ? {}
          : {
              results: [
                {
                  name: 'San Francisco',
                  latitude: 37.77493,
                  longitude: -122.41942,
                  admin1: 'California',
                  country: 'United States',
                  country_code: 'US',
                  timezone: 'America/Los_Angeles',
                },
              ],
            },
      };
    },
    now: new Date('2026-06-29T17:23:04.000Z'),
  });

  assert.deepEqual(requestedNames, ['San Francisco, CA', 'San Francisco']);
  assert.equal(location.id, 'custom:san francisco, ca');
  assert.equal(location.displayLabel, 'San Francisco, CA');
  assert.equal(location.speechLabel, 'San Francisco');
});

test('uses short display label and city-only speech label for geocoded weather', () => {
  const weather = normalizeOpenMeteoResponse(
    {
      id: 'custom:94110',
      displayLabel: 'San Francisco, CA',
      speechLabel: 'San Francisco',
      latitude: 37.77493,
      longitude: -122.41942,
      timezone: 'America/Los_Angeles',
    },
    JACKSON_FORECAST,
    new Date('2026-06-29T17:23:04.000Z'),
  );

  assert.equal(weather.locationLabel, 'San Francisco, CA');
  assert.equal(weather.locationSpeechLabel, 'San Francisco');
  assert.match(weather.spokenSummary, /^In San Francisco,/);
  assert.match(weather.displaySummary, /^San Francisco, CA:/);
});

test('rejects a missing weather location with a configuration hint', async () => {
  await assert.rejects(
    () => resolveWeatherLocation(''),
    (error) =>
      error instanceof WeatherError &&
      error.status === 400 &&
      error.code === 'weather_location_required',
  );
});

test('rejects locations Open-Meteo geocoding cannot resolve', async () => {
  await assert.rejects(
    () => resolveWeatherLocation('nowhere-that-exists', {
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    }),
    (error) =>
      error instanceof WeatherError &&
      error.status === 400 &&
      error.code === 'invalid_weather_location',
  );
});

test('builds graceful summaries with missing fields', () => {
  const weather = {
    locationLabel: 'San Francisco',
    forecastDay: 'today',
    current: { temperatureC: null },
    today: {
      highC: null,
      lowC: null,
      conditionLabel: null,
      precipitationProbabilityMaxPct: null,
    },
    flags: {
      rainLikelyToday: false,
      snowLikelyToday: false,
    },
  };

  assert.equal(buildSpokenSummary(weather), "Here is today's weather for San Francisco. No meaningful rain is expected today.");
  assert.equal(buildDisplaySummary(weather), 'San Francisco: Weather unavailable.');
});
