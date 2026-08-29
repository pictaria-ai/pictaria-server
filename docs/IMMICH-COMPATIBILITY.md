# Immich compatibility

Pictaria Frame and Pictaria Server v1 require **Immich 2.0 or newer**.
Pictaria v1 has been tested with **Immich 2.7.5** and **Immich 3.1.0**.
Other Immich versions may work but are not explicitly validated; consult the
Pictaria release notes before upgrading Immich.

This is a supported-version floor, not an exact allowlist. Pictaria does not
block a newer Immich release merely because it has not been tested yet. Stable
upstream releases are the target; Immich prereleases, forks, and custom builds
are best effort.

## What Pictaria checks

Pictaria Server checks Immich's public server-version endpoint and the API
key's own permission metadata. Its authenticated home-page status distinguishes
among:

- a working connection, including the detected Immich version;
- an API key that Immich rejects;
- a key missing permissions Pictaria needs;
- an Immich version below 2.0;
- an endpoint response that does not provide the compatible API contract; and
- a server that cannot be reached.

An incompatible Immich connection does not prevent Pictaria Server from
starting. This keeps Settings, backups, Activity, and support information
available so the installation can be repaired. Immich-dependent features are
unsupported in this state and may fail until the connection is compatible;
Pictaria Server v1 reports the incompatibility but does not globally stop every
route or background task from attempting to use the configured server.

Pictaria Frame performs the same practical capability check during onboarding
and when connection settings are saved. It identifies rejected keys, missing
read-only permissions, and servers that do not provide the Immich 2.0-era API
contract. The Frame deliberately relies on that capability check instead of
making a second version request.

## API-key permissions

The Frame and Server use separate Immich API keys with different permissions:

- Frame needs only the six read-only permissions listed in its
  [Frame guide](https://pictaria.ai/frame-guide#setup).
- Server needs the permissions listed in
  [Getting started](GETTING-STARTED.md), including the narrowly
  scoped writes used for requested tags, albums, and optional descriptions.

Granting Immich's **All** option works, but grants more access than either
product needs.

## Known compatibility caveat

Optional Enrich caption writeback currently uses Immich's deprecated but still
supported `PUT /assets/:id` endpoint. Immich 3.1.0 stages a `PATCH` replacement,
but does not yet include it in the public API contract, and Immich 2.7.5 does
not provide that replacement. Pictaria therefore keeps the established route
while both tested Immich generations are supported and will migrate when the
replacement is published or removal of the old route is scheduled.

This affects only the optional caption-writeback path, which is off by default.
Location-metadata writeback uses a separate, non-deprecated endpoint.
Neither tested Immich generation exposes an ETag, version precondition, or
expected-description field for this asset update. Pictaria therefore reads the
description at the final safe decision point before writing, but cannot make
that read and the upstream update atomic.

## Before upgrading Immich

1. Read the current Pictaria release notes and any compatibility notices.
2. Confirm the current Pictaria Server backup completed successfully.
3. Upgrade Immich using its documented process.
4. Open Pictaria Server's home page and confirm it reports **Immich connected**
   with the expected version.
5. On a Frame, reload its content and confirm photos display.
6. Exercise one read path (Insights or Timeline/Albums) and, if used, one
   requested write path such as Favorite, Never Show, or a Smart Album sync.
7. If something fails, record the Immich and Pictaria versions before changing
   anything else. Restore or roll back using the products' documented
   procedures rather than attempting an unplanned data downgrade.

## Release-validation checklist

When Pictaria explicitly validates another Immich release, record the exact
Immich Server version and the Pictaria Server and Frame versions tested, then
verify:

- Server connection status and least-privilege API-key validation;
- Insights, Enrich image access, Curate, and Smart Albums;
- Frame onboarding, Albums mode, Timeline mode, and metadata loading;
- Frame-to-Server remote and voice commands, including a tag-writing command;
- restart persistence for settings, Smart Albums, and custom wake phrases; and
- backup creation after the upgrade.

Only add a version to the explicitly tested list after this checklist passes.
