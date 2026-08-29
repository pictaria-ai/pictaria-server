# Backing up Pictaria

Pictaria's most valuable data is the work you can't redo: your Curate
decisions, the AI tags and captions from enrichment runs, your album rules,
location groups, and settings. Your **photos are not part of this** — they
live in Immich and are covered by whatever backs Immich up.

## What to back up

| File | Contents | Replaceable? |
| --- | --- | --- |
| `enrichment.sqlite` (`DATABASE_PATH`) | decisions, tags, captions, run history, review list | **No — the crown jewels** |
| `settings.json` (`SETTINGS_PATH`) | settings overrides, incl. location groups | No |
| `smart-albums.json` (`ALBUMS_DATA_FILE`) | album rules and job state | No |
| `frame.db` (`FRAME_DB_PATH`) | which photos the frame has shown, voice command usage counters | No (small) |
| `insights.sqlite` (`INSIGHTS_DB_PATH`) | library sweep + snapshot | Yes — recomputed from Immich in minutes |
| `wake-word-models/` (`WAKE_WORD_MODELS_DIR`) | custom openWakeWord models and their integrity registry | No — unless you retained the originals |
| `persistent-state.json` | inventory that prevents missing state from being silently recreated | Safety metadata — restore it with the snapshot |

Pictaria creates the initial versioned `settings.json` during startup, even
when you have not saved any runtime overrides. The first automatic snapshot
therefore contains a complete, restorable settings state. If that file later
disappears, backups report it as missing rather than treating the loss like a
fresh installation, including after the server restarts. The shared
persistent-state inventory below owns that distinction.

Pictaria also records a shared persistent-state inventory after every store
has initialized successfully. On later starts it checks that inventory before
opening any database or state store. If `enrichment.sqlite`, `settings.json`,
`smart-albums.json`, `frame.db`, or `wake-word-models/` has disappeared, the
server refuses to recreate an empty replacement and names exactly what must be
restored. `insights.sqlite` is the deliberate exception because it is a cache
that Pictaria rebuilds from Immich. Presence alone is not enough for protected
SQLite state: Pictaria opens it read-only and verifies the stable schema before
normal startup. Backups apply the same validation to their sources and copied
files, require the inventory to name every protected and recomputable role,
and validate the inventory itself before declaring a snapshot complete.
Settings and Smart Album files must parse as their expected versioned JSON
documents, rather than merely existing, and custom wake-word models are
checked against their recorded SHA-256 hashes.

Restored JSON is also bounded before Pictaria buffers or parses it:

| Restored document | Maximum encoded size |
| --- | ---: |
| `persistent-state.json` | 64 KiB |
| `settings.json` | 2 MiB |
| `smart-albums.json` (including `.bak`) | 16 MiB |
| `wake-word-models/registry.json` | 1 MiB |
| `.pictaria-snapshot.json` | 1 MiB |

The limits leave generous room for normal state while preventing a damaged
or substituted file from consuming memory before its schema can be checked.
An oversized protected document is left untouched for repair, blocks normal
startup when required by the persistent-state policy, and makes a backup or
snapshot status incomplete or unknown rather than copying or hashing the
unbounded input.

Custom wake-word restores and snapshots additionally allow no more than 100
registry records, 5 MiB per model, and 50 MiB of model data in total. This is
a fixed recovery envelope rather than the live 20-model upload policy, so a
later policy reduction cannot make already accepted models unreadable or
undeletable. The registry is checked before any model file is opened, and
model integrity is hashed in bounded chunks rather than buffered wholesale.

These checks distinguish a configured path from the restored entries inside
it. It is normal for a configured data parent or `WAKE_WORD_MODELS_DIR` to
resolve through a Docker volume, bind mount, NAS mount, or operator-created
symbolic link. Pictaria follows and pins that trusted boundary. It does not
follow a database, SQLite sidecar, registry, model file, or nested model
directory substituted inside the boundary. Restores also do not have to
preserve the original numeric file owner; the service account only needs the
documented read/write access. A protected file with multiple hard links is
not opened in place because a later permission change or migration could also
change another name for the same inode.

## Recovery before schema migrations

Pictaria records the last server version and persistent-state contract that
completed startup. A release that changes a persisted contract must bump the
contract version in code. On the first start of that release, Pictaria creates
a complete snapshot named like
`YYYY-MM-DD-HH-MM-pre-migration-v1-to-v2` **before** any store opens or any
migration writes. If the backup destination is unavailable, unadopted, or the
snapshot is incomplete, startup stops without running migrations—even when
scheduled backups are disabled.

The persistent-state inventory then records that exact snapshot as a pending
upgrade. If migration or startup fails, the last-successful version does not
advance. The next attempt revalidates and reuses the original snapshot instead
of replacing it with a copy of potentially half-migrated state. The newest
pre-migration snapshot is retained in addition to the configured number of
ordinary backups, and it does not postpone the first normal post-upgrade
backup.

Rollback is deliberately restore-based: stop Pictaria, restore every role
(including `persistent-state.json`) from the named pre-migration snapshot, and
then start the matching older image. Do not point an older image at state that
has already completed a newer migration. Restoring the snapshot removes the
pending marker because the snapshot was captured before that marker existed;
a later attempt with the newer image can therefore create a fresh verified
recovery point and retry safely.

Restore `persistent-state.json` together with the other files in a snapshot.
If you deliberately want to accept lost state and initialize a new baseline,
first preserve any remaining data and backups, then remove both
`persistent-state.json` and `persistent-state.json.initialized` while the
server is stopped. That is an explicit destructive reset: the next start
treats every file currently present—or newly initialized—as the new baseline.

The generated `session-secret` beside `settings.json` is intentionally not in
the built-in snapshot. Losing or restoring without it logs browsers out and
pauses enabled Smart Album schedules as **Needs review**; review each target
and filters, then choose **Review & enable**. Rules, albums, the manual **Run**
action, photos, configuration, curation, and enrichment work remain available.
The server or standalone backup command creates a fresh secret when needed.
Standalone backups use it as the durable local identity for safe lock recovery,
so an unreadable or malformed secret makes the backup fail closed. The secret
itself is never copied into a snapshot.

**Do not** back up a live SQLite database with a plain file copy — a write
during the copy can produce a torn, unopenable file. Pictaria's backups use
SQLite's online-backup API, which is safe while the server runs.

## Built-in automatic backups

The server snapshots everything in the table above, including the current
custom wake-word registry and its exact registered model files, into dated
folders under `BACKUP_DIR` (default: `data/backups/` — **on the same disk**, which
protects against mistakes but not disk failure). Settings → Backups
controls cadence (default: daily) and retention (default: 7 snapshots),
shows the destination and the newest snapshot, and has a **Back up now**
button. A failed snapshot is retried within the hour.

If the configured custom wake-word **root** resolves through a filesystem
symlink, Pictaria pins that operator-selected root and the snapshot stores the
referenced bytes rather than the link. Wake-word snapshots never traverse
nested links or copy unregistered directory entries. If an entry inside the
root is a symlink, special file, or unregistered model, the wake-word target is
omitted, the snapshot is marked incomplete, and none of the suspect target's
bytes are published. Keep custom models as regular files inside the configured
directory.

Every snapshot contains a private `.pictaria-snapshot.json` status manifest
with each copied target's size and SHA-256 integrity. New snapshots also carry
an internal ownership record used to distinguish interrupted Pictaria work from
unrelated files in an adopted backup directory. Status checks validate the
actual snapshot entries without following links, so a target that is
missing, replaced, or modified after publication is shown as damaged and the
snapshot becomes incomplete. The dated directory and manifest timestamp must
also agree within five minutes and may not be more than five minutes ahead of
the server clock. This small allowance tolerates ordinary NAS/host clock
correction without letting a future-dated restored entry suppress backups.
If two backups start during the same UTC minute, the later one uses a name
such as `YYYY-MM-DD-HH-MM-run-0002`. The new snapshot is fully published before
retention may remove the older one, so a failed retry cannot erase the last
published recovery point. Each numbered snapshot is a normal recovery point
and consumes one configured retention slot.
An incomplete run is retained for diagnosis but never evicts a complete
recovery point: Pictaria keeps the configured number of complete snapshots
plus, at most, the newest unresolved incomplete snapshot. Once a later backup
is complete, the obsolete incomplete snapshot is removed. Before retention
deletes an older recovery point, Pictaria fully verifies the newest candidate;
if that candidate is damaged, it walks backward until it finds a verified
complete point and preserves the healthy history. Scheduled cadence uses the
same full content verification asynchronously, cached for one hour so large
NAS snapshots do not block requests or get repeatedly reread. Only a currently
valid, complete snapshot resets the cadence, so an incomplete, damaged, or
future-dated snapshot is retried on the next hourly tick. Snapshots created by
older Pictaria versions have no manifest and are treated as **unknown**, not
complete. Because Pictaria cannot prove it owns those directories, they remain
visible but are never deleted automatically; after confirming that they are
obsolete, move or remove them manually. Cleanup and retention delete only
marked interrupted work and manifest-confirmed Pictaria snapshots. Unrelated
`.partial` or timestamp-named entries are preserved.

The same manual rule applies to a snapshot Pictaria originally created if its
directory and manifest timestamps later stop agreeing or it becomes
implausibly future-dated: Pictaria can no longer prove ownership safely, so
move it aside using the recovery procedure below rather than expecting
retention to remove it.

If an incorrect system clock leaves a future-dated snapshot behind, correct
the clock, move that one dated snapshot directory outside `BACKUP_DIR`, and
choose **Back up now**. Do not rename the snapshot: its directory timestamp
must agree with its manifest. After confirming the replacement is healthy,
the moved copy can be deleted.

For real safety, point `BACKUP_DIR` at another machine:

```bash
# .env — a NAS mount, synced folder, or any off-machine path
BACKUP_DIR=/Volumes/nas/pictaria-backups
```

A custom `BACKUP_DIR` is **adopted once, explicitly**, while the share is
mounted:

```bash
node --env-file-if-exists=.env bin/backup.mjs --adopt
```

That creates the directory on the real destination and stamps a
`.pictaria-backup-destination` marker file into it (creating the marker by
hand as a regular file works too). The configured root may itself be a normal
NAS mount, bind mount, or intentional filesystem symlink; adoption pins the
resolved directory while entries restored inside it are never trusted as
links. From then on, every backup — scheduled, Back up now, or
`bin/backup.mjs` — requires the marker before writing: the server never
creates or adopts a custom destination on its own, so an absent mount
fails loudly in every shape it takes (path gone on macOS, an empty
mount-point directory on Linux, even a phantom folder full of old
snapshots) instead of silently snapshotting onto the local disk. The
failure shows up in Settings → Backups and the next hourly tick retries;
once the share is back, backups resume by themselves. A replaced disk at
the same path is re-adopted the same one-time way. Only the default
`data/backups` — on the server's own data disk, where no mount is
involved — is created and adopted implicitly.
If that implicit default path is unexpectedly a symbolic link, Pictaria
refuses it; set the intended linked location explicitly with `BACKUP_DIR` and
adopt it once instead.

The other machine doesn't have to be on your LAN: a NAS or spare box
reachable over Tailscale works the same — mount its share across the
tailnet and point `BACKUP_DIR` at the mount. Snapshots then leave the
building encrypted end-to-end, with no file share exposed to the local
network or internet.

## Manual / cron backups

`bin/backup.mjs` runs the same snapshot logic standalone — useful for cron
or launchd jobs, and safe to invoke while the server is up. Scheduled,
on-demand, migration, and standalone backups all use the same atomic lock in
the destination. If another process already holds it, the later attempt exits
without copying, cleaning, publishing, or rotating anything; the server's
button reports that a backup is already running.

```bash
cd /path/to/pictaria-server
node --env-file-if-exists=.env bin/backup.mjs

# or to a different destination than the server's:
BACKUP_DIR=/mnt/nas/pictaria node --env-file-if-exists=.env bin/backup.mjs
```

Pictaria automatically recovers a same-host lock only when the recorded process
is definitely gone. During a controlled server shutdown, it also explicitly
hands an active lock back to this persistent installation immediately before
exiting. That handoff lets an ordinary Docker replacement reclaim the lock even
when Docker assigns a new container hostname. The non-secret installation
fingerprint is derived from Pictaria's random installation secret; the secret
itself never leaves the data directory.

A malformed lock, a lock from another installation, an unidentified lock, or
an unhanded-off lock from another hostname is deliberately preserved. The last
case can remain after a power loss, `SIGKILL`, or other ungraceful container
termination. First confirm that no server, cron, container, or other machine is
using that destination; only then remove the one `.pictaria-backup.lock`
directory and retry. There is no age-based expiry because a large backup to a
slow NAS may legitimately run for a long time.

The installation secret is intentionally excluded from snapshots. A restored
clone therefore gets a different lock identity and cannot reclaim the source
installation's NAS lock. If recovery moved the installation permanently, first
confirm the source is stopped, then remove any old lock manually.

Docker users: the image points the built-in default at `/data/backups`
(via `BACKUP_DIR_DEFAULT`, which relocates the trusted default without
making it look user-selected — no adoption needed), so automatic
snapshots land inside the persisted `/data` volume out of the box. For
off-machine safety, bind-mount the NAS or synced folder at a **separate
container path** and set `BACKUP_DIR` to it (see the commented lines in
`docker-compose.yml`), then adopt it once:

```bash
# .env — this is the container path, not the host/NAS path
BACKUP_DIR=/backups

docker exec pictaria node bin/backup.mjs --adopt
```

Never bind the NAS over `/data/backups` itself — that path is the
implicitly-trusted default, so a failed bind presenting a local directory
there would be written without complaint. A separate path under
`BACKUP_DIR` gets the full custom-destination guard. `docker exec
pictaria node bin/backup.mjs` works for cron-driven runs too.

## Best practices

1. **Get the snapshots off the machine.** Same-disk backups only protect
   against software mistakes. NAS mount, synced folder, then off-site
   (e.g. your NAS's cloud backup job) is the full chain.
2. **Daily is enough.** This data changes at the speed you curate.
3. **Watch the enrichment DB location.** If you set `DATABASE_PATH`
   somewhere custom, generic "back up the data folder" scripts will miss
   it — the built-in backup reads the config, so it never does.
4. **Test a restore once.** Copy a snapshot's files over a fresh install's
   paths, start the server, and check Curate shows your decisions. A backup
   you've never restored is a hope, not a backup.
5. `insights.sqlite` can be excluded from off-site copies if space matters
   — one Refresh rebuilds it.

## Restoring

Stop the server, copy the files from a snapshot folder back to their
configured paths (table above), start the server. Databases are plain
SQLite files; there is no import step.

Use a normal byte-for-byte **copy**, not a symbolic or hard link, for each
restored file. It is fine for the configured parent directory itself to be a
link or mounted path. If a backup tool restores ownership using a different
numeric UID, make the files readable and writable by the account/container
that runs Pictaria; matching the old UID is not otherwise required. Preserve
`persistent-state.json` with the rest of the snapshot.

On startup, Pictaria validates protected state before migrations or normal
stores open. A concise `Refusing to start` message means the named core role
must be restored or deliberately reset; Pictaria does not create an empty
replacement. Unsafe custom wake-word storage is the narrow exception: the
server continues with built-in wake-word support, warns that custom storage
is disabled, leaves the suspect directory untouched, and reports custom-model
operations unavailable. Backups remain incomplete until that storage is
repaired. A missing custom-model registry or a recorded model that fails its
integrity check still refuses startup because that is evidence of lost
protected state, not merely an unsafe access path.
