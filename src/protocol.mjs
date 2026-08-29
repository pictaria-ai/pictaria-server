// The app/server protocol contract — a version handshake, not a negotiation.
//
// PROTOCOL_VERSION bumps ONLY on a breaking change to the app-facing
// contract: the shape or semantics of remote commands, frame state, SSE
// events, or authentication. Additive fields never bump it.
//
// MIN_APP_PROTOCOL bumps ONLY when this server drops support for apps that
// speak an older protocol — an app whose supported protocol is below this
// must update before pairing.
export const PROTOCOL_VERSION = 1;
export const MIN_APP_PROTOCOL = 1;

// Optional features the app may gate UI on, as stable strings. Each names a
// real route surface; remove one only when the routes go away.
export const SERVER_CAPABILITIES = Object.freeze([
  'remote-commands', // POST /api/frame/command + /api/frame/state, SSE command/state events
  'named-frames', // device= on /api/frame/events, device-targeted commands, /api/frame/devices
  'display-reports', // POST /api/frame/displays + /api/frame/display-stats (durable ledger)
  'voice', // /api/voice/* (transcribe, intent, tts), /api/assets/:id/*, /api/photos/show-search
  'voice-ask', // POST /api/voice/ask (one-shot LLM Q&A for the "tell me" command)
  'weather', // GET /api/weather
  'custom-wake-word-models', // authenticated registry + immutable model downloads for Connect frames
]);
