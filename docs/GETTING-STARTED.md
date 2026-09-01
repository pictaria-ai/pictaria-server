# Getting started — the first-run checklist

The [Quick start](../README.md#quick-start-docker) gets the container
running. This is everything after that, in the order that makes sense.
Items marked *optional* unlock a feature and can be done anytime — nothing
else waits on them.

- [ ] **Log in.** Open `http://your-host:4080` and enter the
  `APP_PASSWORD` you set in `.env`. The browser holds a session from then
  on (it lasts 30 days). On your home network,
  `your-host` is the machine's LAN name or IP; if both ends run
  [Tailscale](https://tailscale.com), its MagicDNS name works the same
  from anywhere, encrypted end-to-end, with no port opened to the world —
  see [Exposing beyond your LAN](../README.md#exposing-beyond-your-lan).

- [ ] **Connect Immich.** Settings → Server: your Immich URL and an API
  key (create one in Immich under **Account Settings → API Keys**). The
  home page shows a setup callout until this is done. Pictaria only ever
  *reads* your library, plus the tags/albums/descriptions you explicitly
  ask it to write.

  Both HTTP and HTTPS are supported: use `http://` on a trusted LAN/VPN or
  `https://` with normal certificate validation. Enter the full `https://`
  scheme when you want TLS; an address without a scheme defaults to HTTP. Use
  the Immich root address, not an API endpoint—Pictaria removes a trailing
  `/api` if present.
  Publicly trusted certificates work normally. For a private/home CA, make the
  CA trusted inside the Pictaria Server container as described in
  [Configuration](CONFIGURATION.md#immich-http-https-and-private-cas); Pictaria
  does not disable certificate validation.

  Pictaria Server v1 requires Immich 2.0 or newer and has been explicitly
  tested with Immich 2.7.5 and 3.1.0. Other versions may work but are not
  explicitly validated; see [Immich compatibility](IMMICH-COMPATIBILITY.md)
  and the Pictaria release notes before upgrading Immich.

  The key doesn't need full access. For least privilege, tick exactly
  these 15 boxes in Immich's permission picker when creating it:

  > `asset.read` · `asset.view` · `asset.download` · `asset.statistics` ·
  > `asset.update` · `person.read` · `person.statistics` · `album.read` ·
  > `album.create` · `album.delete` · `albumAsset.create` ·
  > `albumAsset.delete` · `tag.read` · `tag.create` · `tag.asset`

  Also enable **Tags** in Immich under **Account Settings → Features** for
  the same Immich account that owns this API key. This account-level switch
  and the API-key permissions are separate. Turning Tags on normally does not
  require a new key when the existing key already has `tag.read`,
  `tag.create`, and `tag.asset`. If Pictaria still reports a missing permission
  or synchronization continues to fail, recreate the key and save the
  replacement in Settings → Server.

  Roughly: the reads power search, Insights, and image fetches; `album.*`
  is Smart Albums doing its job — `albumAsset.create`/`albumAsset.delete`
  re-sync each album to its rule on every run (photos that stop matching,
  rank out of a Best-of cap, or get the voice command "never show this
  photo" come out), and `album.delete` is narrower than it looks: its only
  use is removing a just-created, still-empty album when saving a new rule
  fails halfway. Deleting a smart-album rule never deletes your Immich
  album. `tag.*` is Curate, Enrich, and Voice
  tagging. `asset.update` is the one conditional box: it covers only the
  two opt-in write-backs (Enrich captions, voice location labels), both
  off by default, so the strict minimum is the other 14 if you leave
  them off. It's in the recommended list so switching them on later
  never means re-creating the key — with a 14-box key, an enabled
  write-back fails as 403s in the log until you add the permission.
  Granting **All** works too, if you'd rather not pick boxes. The permission
  checklist was verified against Immich v2.7.5 and v3.1.0; if a
  future Immich renames a permission, the symptom is a clean 403 in the
  log naming the endpoint. (Pictaria Frame asks for its own key during
  device setup — its frame guide lists the shorter, strictly read-only
  set that key needs.)

- [ ] **Let Insights sweep.** It starts on its own shortly after Immich
  connects and takes a few minutes for large libraries. When it finishes,
  the Insights page is your library's story — start clicking.
  ([How it works.](INSIGHTS.md))

- [ ] **Install Pictaria Frame** on the device that will be your frame.
  Its setup wizard asks for Immich, your photo albums, this server's URL
  and password, and a **device name** — that name is how the frame appears
  in the Remote page, the Frame stats, and Settings → Devices. Run several
  frames off one server by giving each its own name.

- [ ] *Optional* — **Enable Enrich.** AI tagging and captions are **off by
  default** because each run sends the selected image rendition to its chosen
  model. Configure the connection and
  model identifier under Settings → AI Providers, then open Enrich and choose
  the provider for new runs. That choice is remembered across visits and
  server restarts. Ollama and LM Studio keep everything on your own hardware;
  OpenAI, OpenRouter, Venice, and Ollama's cloud models are the cloud routes.
  Captions are stored in Pictaria by default; Immich descriptions remain
  unchanged unless you separately turn on **Write captions to Immich
  descriptions**. Use **Write existing captions now** to copy captions made
  before enabling that option.
  ([Pipeline, providers, taxonomy.](ENRICH.md))

- [ ] *Optional* — **Get a free Geoapify key** for place names. Weather
  needs no account or key: it sends the frame's city or US ZIP to Open-Meteo
  for geocoding, then the resulting coordinates for the forecast. Separately,
  turning photo GPS into names — the location labels on the frame, voice
  answers like "where was this taken?", and Insights' home-base name —
  uses reverse geocoding. Create a free account at
  [geoapify.com](https://www.geoapify.com/) (the free tier's 3,000
  requests/day is far more than a frame ever uses), then set provider and
  key under Settings → Location Names.

- [ ] *Optional* — **Voice.** Configure the model connections you want under
  Settings → AI Providers, then choose the models and text-to-speech provider
  under Settings → Voice TTS; say “Hey Pictaria” to the frame. The one-time
  Pictaria Connect in-app upgrade for Pictaria Frame also supports
  administrator-uploaded custom wake phrases on Android frames.
  When invoked, **Interesting** sends the current photo's Immich preview plus
  its date, location, and filename to the selected voice-answer model. This is
  independent of the Enrich switch; choose a local model to keep the request
  within infrastructure you operate.
  Try the voice testers at the bottom of Voice TTS, and see [Wake words and
  custom wake phrases](WAKE-WORDS.md) for model creation, licensing, testing,
  and deployment. If you want a known starting point rather than choosing from
  scratch, use the dated [recommended-model guide](RECOMMENDED-MODELS.md).

- [ ] **Point backups somewhere safe.** Automatic snapshots of the
  irreplaceable data (your Curate decisions, tags, album rules, settings)
  run daily out of the box, but they land inside the container volume
  unless you point `BACKUP_DIR` at a NAS mount or synced folder.
  ([What's backed up and how to restore.](BACKUP.md))

- [ ] *Optional* — **Group nearby cities** (Settings → Location Groups) so
  Insights counts "Bay Area" instead of thirty suburbs, and **pick a
  favorites tag** (Insights → gear on the Favorites tile) if you don't use
  Immich hearts.

From here the flow strip on the home page is the map: **Insights** to
understand the library → **Enrich** to tag it → **Curate** to choose what
the frame shows → **Albums** to keep smart albums fresh
([how they work](ALBUMS.md)) → Pictaria Frame displays it all, with **Remote**
in your pocket.

When a new Pictaria Server release comes out, follow
[Upgrading](UPGRADING.md) — it covers the Docker and bare-Node procedures,
what migrates automatically, and how to roll back.
