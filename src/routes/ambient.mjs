import { sendError, sendJson } from '../http.mjs';
import { getWeather, WeatherError } from '../ambient/weather.mjs';

export function createAmbientRoutes({ config }) {
  return async function handleAmbientRoute(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/weather') {
      const location =
        url.searchParams.get('location') ||
        url.searchParams.get('zip') ||
        url.searchParams.get('locationId') ||
        config.ambient.weatherDefaultLocation ||
        undefined;
      try {
        sendJson(response, 200, await getWeather(location, {
          forecastDay: url.searchParams.get('forecastDay') || url.searchParams.get('day') || undefined,
        }));
      } catch (error) {
        if (error instanceof WeatherError) {
          sendError(response, error.status, error.code, error.message);
          return true;
        }
        throw error;
      }
      return true;
    }

    return false;
  };
}
