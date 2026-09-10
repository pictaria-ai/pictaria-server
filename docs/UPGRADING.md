# Upgrading Pictaria Server

Moving an existing install to a newer Pictaria Server release.

Upgrades are forward-automatic: schema migrations run at boot, and established
installations receive a verified snapshot before any migration that changes
persisted state. A fresh, complete backup is still a prerequisite for every
upgrade.

## Before you upgrade

1. **Read the release notes.** [CHANGELOG.md](../CHANGELOG.md) lists new
   settings, new environment variables, and any compatibility notices for the
   release you are moving to.
2. **Create a fresh backup and confirm it completed.** Use **Back up now** in
   Settings → Backups, or run the command in [BACKUP.md](BACKUP.md), then
   confirm the newest snapshot is complete. If snapshots are failing, fix
   that first. This manual pre-upgrade snapshot is the recovery point for an
   ordinary code-only release.
3. **Note the snapshot name and running version.** Settings → Server shows
   `Pictaria Server v<version>`. You need it to roll back, or to report a
   problem.

## Upgrade — Docker

```sh
PICTARIA_RELEASE=v1.2.0 # replace with the release you are installing
curl -fsSL -o docker-compose.release.yml \
  "https://raw.githubusercontent.com/pictaria-ai/pictaria-server/${PICTARIA_RELEASE}/docker-compose.yml"
diff -u docker-compose.yml docker-compose.release.yml
```

Review the difference. If you customized ports, bind mounts, or environment
pass-throughs, reapply those site-specific changes to
`docker-compose.release.yml`. A tagged release file defaults to its matching
versioned image tag. That name identifies the intended release, but a tag by
itself is not a cryptographic digest. The publish workflow records the
multi-platform manifest digest in its job summary; after verification, that
digest is copied into the corresponding GitHub Release. For strongest
verification, use that recorded digest. Verify the resolved release name before
continuing:

```sh
docker compose -f docker-compose.release.yml config --images
```

The printed image must end in the numeric image version corresponding to the
source release you selected (`v1.2.0` uses image tag `1.2.0`). Next, make a
rollback definition from the currently running Compose file. It should already
resolve to the version you noted under Settings → Server; verify it before
replacing the active definition:

```sh
cp docker-compose.yml docker-compose.previous.yml
docker compose -f docker-compose.previous.yml config --images
mv docker-compose.release.yml docker-compose.yml
docker compose config --images
docker compose pull
docker compose up -d
```

The first image must name the version that was running before the upgrade and
the second must name the release you are installing. Do not continue unless
both are explicit versions. `PICTARIA_IMAGE_TAG` is an escape hatch for
deliberate testing; do not leave it set during a normal release upgrade.

If you build the image from a local checkout instead of pulling the published
one:

```sh
test -z "$(git status --porcelain)" || {
  echo "Stop: preserve or reconcile local changes before upgrading."
  exit 1
}
PICTARIA_RELEASE=v1.2.0 # replace with the release you are installing
git fetch --tags --prune
git switch --detach "$PICTARIA_RELEASE"
docker compose up -d --build
```

The guard stops before fetching or switching when the checkout has local
changes. A release tag installs reviewed release code; pulling `main` would
install the moving development branch instead.

Both paths recreate the container. Your data survives because it lives on the
`pictaria-data` volume rather than inside the container.

> **Warning:** if you changed the compose file so that `/data` is not on a
> named volume or a bind mount, recreating the container destroys your Curate
> decisions, tags, album rules, and settings. Check this before you upgrade,
> not after.

## Upgrade — bare Node

```sh
test -z "$(git status --porcelain)" || {
  echo "Stop: preserve or reconcile local changes before upgrading."
  exit 1
}
PICTARIA_RELEASE=v1.2.0 # replace with the release you are installing
git fetch --tags --prune
git switch --detach "$PICTARIA_RELEASE"
```

The guard stops before fetching or switching when the checkout has local
changes. Do not use `git pull` as the upgrade step; `main` is the moving
development branch, whereas version tags identify reviewed releases.

Then restart the process through whatever supervises it:

- **systemd** — `sudo systemctl restart pictaria-server`
- **launchd** — `kill` the process; `KeepAlive` relaunches it on the new code

Both service definitions are in [RUNNING.md](RUNNING.md). There is no install
step: Pictaria Server has zero npm dependencies. Do check the release notes
for a raised Node requirement — `engines` is `^22.16.0 || >=23.8.0` today, and
a build below it fails at boot rather than starting degraded.

A run that is in flight when the process stops is recorded as *interrupted*;
its queue item stays queued and resumes on the next run.

## What happens automatically on the first start

- **A pre-migration snapshot, when an established installation's
  persisted-state contract changes.** Before any store opens, Pictaria writes
  a complete snapshot named like
  `2026-08-18-14-30-pre-migration-v1-to-v2`. If the backup destination is
  unavailable or unadopted, or the snapshot comes out incomplete, startup
  stops and no migration runs — even when scheduled backups are disabled.
  That snapshot is retained on top of your configured retention count.
- **Schema migrations.** They run at boot and are one-way. A database that has
  completed a newer migration is not guaranteed to open under older code.
- **New settings take their defaults.** A value saved in the UI keeps
  overriding its environment variable until you clear it.
- **Existing Smart Album schedules need one confirmation after this upgrade.**
  Enabled rules are paused and marked **Needs review**. Check the target and
  filters, then choose **Review & enable**. This also protects schedules
  restored onto a different installation or found after the generated
  `session-secret` was lost or regenerated.

## Verify the upgrade took

1. Settings → Server shows the new version.
2. The home page reports **Immich connected** with the expected Immich
   version.
3. On a frame, confirm photos still display and one remote or voice command
   still works.

For a scripted check, query the health endpoint with credentials:

```sh
umask 077
header_file="$(mktemp)"
trap 'rm -f "$header_file"' EXIT
read -rsp 'Pictaria password: ' pictaria_password; printf '\n'
printf 'X-App-Password: %s\n' "$pictaria_password" > "$header_file"
unset pictaria_password
curl -s -H "@$header_file" http://your-host:4080/api/health
```

This keeps the password out of shell history and process arguments. The
temporary header file is owner-only and removed when the shell exits.

The authenticated payload includes `serverVersion`, `protocolVersion`,
`minAppProtocol`, and the Immich status. Unauthenticated callers get only
`ok`, `service`, `time`, and `authRequired` — no version.

## Rolling back

The safe path depends on whether startup migrated persistent state:

- **A named `pre-migration-v…-to-v…` snapshot was created.** Stop the server,
  restore **every** role from that snapshot — including
  `persistent-state.json` — and start the matching older image or source tag.
  Never point the older release at state that completed the newer migration.
  Restoring the snapshot clears the pending-upgrade marker, so a later retry
  can create a fresh recovery point and migrate safely.
- **No persisted-state migration occurred.** If the release notes explicitly
  say the persistent-state contract is unchanged and no named pre-migration
  snapshot appeared, stop the server and return to the previous image or
  source tag without restoring data. This preserves work performed after the
  upgrade. Keep the manual pre-upgrade snapshot as the emergency recovery
  point; restoring it discards changes made since it was taken.
- **You are unsure whether persisted state changed.** Stop the server and
  restore the complete manual pre-upgrade snapshot before starting the older
  release. Do not guess about downgrade compatibility.

Use the command for your installation type to stop Pictaria and keep it
stopped while files are restored or versions are switched:

```sh
# Docker
docker compose stop pictaria

# Linux bare Node (systemd)
sudo systemctl stop pictaria-server

# macOS bare Node (launchd)
launchctl bootout gui/$(id -u) \
  ~/Library/LaunchAgents/com.example.pictaria-server.plist
```

For Docker, restore the previously versioned `docker-compose.previous.yml` as
`docker-compose.yml` and pull that prior image. Confirm its `image:` line names
the prior version before starting it. For a source install, switch to the prior
version tag. The complete restore procedure, including the explicit
destructive reset, is in [BACKUP.md](BACKUP.md), "Recovery before schema
migrations."

After the prior version and, when required, the complete snapshot are in place,
restart with the matching command:

```sh
# Docker
docker compose up -d pictaria

# Linux bare Node (systemd)
sudo systemctl start pictaria-server

# macOS bare Node (launchd)
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.example.pictaria-server.plist
```

If you changed the example launchd filename, use your actual plist path in
both commands.

## Pictaria Frame and the protocol handshake

Pictaria Server and Pictaria Frame version independently. A handshake governs
the pairing: the server reports `protocolVersion` and `minAppProtocol` in the
authenticated health payload and in the first event on every stream, and
Frame compares both against the protocol it speaks.

**Upgrade the server first, then Pictaria Frame.** A newer server with an older
Frame release is the tolerated direction; the reverse is not guaranteed.

What Frame does with each outcome:

- **Server newer, Frame still supported** — everything Frame already knows
  keeps working, and it tells you the server speaks a newer protocol and that
  updating Pictaria Frame unlocks the rest.
- **Frame below the server's minimum** — Frame refuses and tells you to update
  Pictaria Frame. This happens only on a release that explicitly drops support
  for older Frame releases, which the changelog calls out.
- **Server predates protocol versioning** — still works; Frame suggests
  updating the server.

Today the server speaks protocol 1 and requires Frame protocol 1, and Pictaria
Frame speaks protocol 1 — there is no skew in either direction yet.

## Immich upgrades are a separate decision

Upgrading Pictaria Server never requires upgrading Immich unless the release
notes say so. Immich upgrades have their own prerequisites and their own
pre-flight checklist — see
[Immich compatibility](IMMICH-COMPATIBILITY.md), "Before upgrading Immich."

Do not upgrade both on the same day. If something breaks afterwards, you want
to know which upgrade caused it.

## Upgrading to v1.2.0

v1.2.0 upgrades persistent-state contract 8 from v1.1.0 to **contract 15**,
with **Enrich schema 12** and **settings version 7**. Upgrades from earlier
v1.2 development builds follow any remaining migrations. The release does
not require a new Immich or Pictaria Frame version.

### Before and after first startup

Create a complete backup using the checklist above. Startup also creates a
complete pre-migration recovery snapshot before changing persistent state.
Retain that snapshot and the previous image/version. Existing enrichment
results, human decisions, queued photo selections, and retained history are
preserved, subject to the configured history limits.

After startup, check:

- **Settings → Enrichment profiles:** existing effective prompts and taxonomy
  seed the initial active profile, **My profile**, once. Verify your
  customization, then edit inference content through profiles. The shared
  live Curate review policy remains separate. Changes to configured prompt
  files do not subsequently rewrite saved profiles.
- **Enrich:** confirm the active profile and provider. Every new execution,
  including Daily Enrich and queued jobs, uses the active revision at start;
  running work and automatic retries retain captured inputs. Earlier v1.2
  preview queue pins are cleared without removing selected photos or history.
- **Immich tag sync:** newly successful enrichments sync AI tags whether or
  not Send to Curate is selected. Ensure the API key has the required tag
  permissions; pending/failed status and retry are on Enrich. Older enriched
  photos are not automatically backfilled.
- **Run history:** defaults retain 100 summaries/Performance entries and logs
  for 100 runs. Settings can retain 100–1,000 summaries and independently
  0–100 logs. Lower limits prune immediately after confirmation; raising a
  limit does not recover deleted records. Photo/request detail is separately
  bounded.

Pictaria reconciles all tags within its **ai/** namespace, including stale or
manually added tags within that prefix. Automatic AI sync preserves human
**frame/** decisions and tags outside **ai/**. Tag-based searches and albums
can now include enriched photos before they have been curated.

### Discovery, history, and processing behavior

The first budgeted library sweep builds a resumable inventory. Later sweeps
fetch changed metadata, including uploads with older capture dates, and use
local SQL to select work. A full metadata reconciliation occurs on the first
sweep after 24 hours and can also follow a burst of stale candidates. This is
expected metadata work, not re-enrichment of the whole library.

Bounded or interrupted discovery retains its checkpoint. An incomplete result
asks for another run instead of claiming the library is caught up. Daily
Enrich keeps its once-per-day attempt policy. See
[library discovery and freshness](ENRICH.md#library-discovery-and-freshness)
for eligibility, timing-boundary and pagination limits.

**Only unenriched** continues to skip every previous success. With it off,
legacy results with unknown configuration inputs may be reprocessed. Legacy
failures no longer count toward the current configuration's failure limit,
so later sweeps may make fresh provider calls for previously stuck photos.
A library sweep sends only its new successful results to Curate; explicitly
targeted selections can still send existing results.

Historical settings and timing are not reconstructed from logs. Saved
configuration and timing records identify new runs; older or expired details
remain explicitly unavailable. On restart, unfinished photo/request timing
records become interrupted while completed measurements remain intact.

### Backup and rollback

Standard complete backups include profiles, configuration snapshots, timing,
inventory/checkpoints, history preferences, and pending AI-tag synchronization.
A restored discovery lease can delay new discovery for up to five minutes.
Changing the Immich URL or API key rebuilds only the inventory, preserving
enrichment history and human decisions.

For rollback, stop the server and restore the **complete pre-upgrade snapshot**
into a clean data directory/volume with the matching older build, following
[Rolling back](#rolling-back). Never run v1.1.0 or an older development build directly
against state already upgraded beyond its supported contract.

Restoring Pictaria state does not undo tags or captions already written to
Immich, or changes made in Immich itself.
