import { isIP } from 'node:net';

const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.home.arpa', '.ts.net'];

export function createBrowserAuthorityPolicy(configuredHosts = '') {
  const configured = String(configuredHosts)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseConfiguredHost);

  return {
    isAllowed(hostHeader) {
      const candidate = parseHostHeader(hostHeader);
      if (!candidate) {
        return false;
      }
      if (isLocalBrowserHost(candidate.hostname)) {
        return true;
      }
      return configured.some((entry) => (
        entry.hostname === candidate.hostname
        && (!entry.port || entry.port === candidate.port)
      ));
    },
  };
}

function parseConfiguredHost(value) {
  if (value.includes('://')) {
    throw new Error('BROWSER_ALLOWED_HOSTS entries must be host[:port], not URLs.');
  }
  const parsed = parseHostHeader(value);
  if (!parsed) {
    throw new Error(`BROWSER_ALLOWED_HOSTS contains an invalid host: ${value}`);
  }
  return parsed;
}

function parseHostHeader(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\\/\s@]/.test(raw)) {
    return null;
  }
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    const explicitPort = raw.match(/:(\d+)$/)?.[1];
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
      // URL canonicalization removes the default HTTP port. Preserve an
      // explicitly supplied port so allowlist entries remain port-specific.
      port: explicitPort === undefined ? parsed.port : String(Number(explicitPort)),
    };
  } catch {
    return null;
  }
}

function isLocalBrowserHost(hostname) {
  return isIP(hostname) !== 0
    || hostname === 'localhost'
    || !hostname.includes('.')
    || LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}
