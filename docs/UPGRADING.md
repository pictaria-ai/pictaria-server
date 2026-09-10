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
PICTARIA_RELEASE=v1.1.0 # replace with the release you are installing
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
source release you selected (`v1.1.0` uses image tag `1.1.0`). Next, make a
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
PICTARIA_RELEASE=v1.1.0 # replace with the release you are installing
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
PICTARIA_RELEASE=v1.1.0 # replace with the release you are installing
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

## Named Enrich profiles (unreleased v1.2 work)

Schema 9 / persistent-state contract 11 provides profiles and one server-saved
active choice. Earlier v1.2 previews used contract 10 with per-item queue pins.
Upgrading preserves the saved default as the active profile and clears pending
queue pins; photo selections, immutable revisions, and run history are retained.
The physical `is_default` column stores the active choice, and the nullable
queue pin column is retained for compatibility but is no longer used.
Contract 11 ensures a recovery point before this behavior/state conversion.
For installations without profiles, first boot copies effective prompts/taxonomy
into the initial active profile, My profile; it does not launch enrichment. Verify
the active profile contains your customization and the queue still shows its
expected slices. Subsequent inference edits belong in Settings → Enrichment
profiles; Settings retains the shared live Curate policy. Changing configured files later does not rewrite saved profiles.
See [profile behavior and migration](ENRICH.md#enrichment-profiles).

Startup takes the usual complete pre-migration snapshot before mutation.
Rollback requires restoring that snapshot into a clean volume with the older
image; do not run an older server directly against the new database. Profile
revisions and the active choice live in enrichment.sqlite and are included
in standard backups.


## Enrich history retention (unreleased v1.2 work)

Settings version 7 / persistent-state contract 14 adds bounded run-summary
and diagnostic-log preferences. The Enrich database remains at schema 11.
Existing installations retain the defaults of 100 summaries and 100 logs;
migration does not create overrides that would hide environment preferences.
The same summary limit applies to Performance timing-run entries, while
photo/request detail retains its separate bounds.

The normal recovery point is created before settings migration and startup
pruning. It preserves the prior version-6 settings and retained history.
Settings and databases are included in normal backups, so restoring a current
backup also restores its retention preferences. Lowering a configured limit
prunes immediately on save or startup; raising it cannot restore old records.
For rollback, restore the pre-upgrade snapshot with its matching older build;
do not run older code directly against contract-14 state.

## Enrich discovery (unreleased v1.2 work)

Schema 11 / persistent-state contract 13 adds a rebuildable Enrich inventory,
a staging table, and a checkpoint/lease record to enrichment.sqlite. Existing
processing history, results, queues, profiles, and human decisions remain
unchanged. No historical assets are assumed to form a complete inventory;
the first budgeted library sweep constructs one from Immich.

The standard pre-migration recovery point is created before this migration.
Normal backups include both the published inventory and any saved in-progress
scan. Resume uses the same source credentials; a URL/key change starts a fresh
inventory without clearing enrichment history. A restored active lease can
delay discovery for up to five minutes before it expires.

Rollback requires the pre-upgrade snapshot and its matching older build. Do
not run an older server directly against contract-13 state. The upgrade tests
verify that a contract-12/schema-10 recovery snapshot contains neither the
new tables nor changes to existing job history.

## Enrich timing (unreleased v1.2 work)

Schema 10 / persistent-state contract 12 adds timing runs, photo executions,
and provider attempts, plus a nullable `job_runs.timing_run_id` link. No
historical measurements are reconstructed from logs or processing-row
creation timestamps. Older job summaries have no timing link. Enrichment
results, active profiles and immutable revisions, queue selections, and
human decisions keep their existing meaning.

The automatic pre-migration recovery point precedes this change. Timing
records live in enrichment.sqlite and are covered by the existing complete
backup/restore path. Tests cover upgrading the schema-9 profile release,
restoring its pre-upgrade snapshot with contract 11 and no timing tables,
and round-tripping new measurements and profile attribution through backup.
Rollback requires that snapshot and the corresponding older server; never
open contract-12 state with an older build.

On startup, unfinished photo executions and requests become **interrupted**,
with unknown finish times/durations left null. Completed requests retain
their measurements, even when the enclosing run never wrote a job summary.
Repeated startup does not replace completed measurements or invent elapsed
wall time. See [timing and retention](ENRICH.md#photo-and-provider-request-timing).
