# Wake words and custom wake phrases

Pictaria Frame listens locally for a short phrase before it starts speech
recognition. On Android, every Frame includes **“Hey Pictaria,”** so that detector
does not require a model download. Voice command handling still requires
**Pictaria Connect** — the one-time Frame in-app upgrade that enables Server
features — and a configured Pictaria Server.

Pictaria Connect also lets an administrator upload a compatible custom
openWakeWord model to Pictaria Server and select that model independently on
each frame. The model is downloaded only when it is selected. After a
successful installation, wake-word detection remains local to the frame and
continues to work while Pictaria Server is temporarily unavailable.

This document covers the current user workflow, model requirements, lifecycle,
troubleshooting, storage, validation, and API contract.

## At a glance

- **Built-in phrase:** “Hey Pictaria”
- **Custom models require:** Pictaria Connect, Pictaria Server, and
  Pictaria Frame on Android
- **Model format:** compatible openWakeWord TensorFlow Lite (`.tflite`)
- **Create a model:** [openwakeword.com](https://openwakeword.com) — download
  the `.tflite` version
- **Maximum model size:** 5 MiB
- **Default threshold:** normally `0.5`
- **Processing:** wake-word audio and inference remain on the frame
- **Offline behavior:** an installed model works without a live server
  connection
- **Fallback:** if the selected custom model cannot start, the frame uses
  “Hey Pictaria” rather than disabling voice

Custom models are managed centrally on the server but selected separately on
each frame. Uploading a model does not automatically activate it or push it to
every device.

## Requirements

Before using a custom wake phrase:

1. Pictaria Server must be running and reachable from the frame.
2. The frame must be connected to that server under **Settings → Pictaria
   Server**.
3. The frame must have Pictaria Connect access.
4. Voice Commands must be enabled on the frame. It is the master switch for
   both the wake listener and command handling.
5. Android microphone permission must be granted.
6. You must have a compatible `.tflite` wake-word model and the right to use
   it on your devices.

Custom wake-word models are currently supported on Android only.
They are available in Pictaria Server `1.0.0` and Pictaria Frame `1.0.0`.
Both sides must advertise the `custom-wake-word-models` capability. If an
older frame or server does not show the custom-model controls, update it
before troubleshooting the model itself.

## The built-in “Hey Pictaria” phrase

“Hey Pictaria” is packaged with the Android app, available offline immediately,
and is the safe default for new installations. It does not have to be uploaded
to Pictaria Server.

To use or restore the built-in phrase:

1. Open **Settings** on the frame.
2. Find **Pictaria Server → Voice Commands → Wake Phrase**.
3. Select **“Hey Pictaria.”**
4. Save Settings.
5. Return to the slideshow and wait for **Voice ready**.

## Set up a custom wake phrase

### 1. Obtain or train a compatible model

Pictaria accepts an openWakeWord-style wake classifier exported as a TensorFlow
Lite `.tflite` file. The model must meet the compatibility requirements later
in this document.

Each model may be up to 5 MiB. A server retains at most 20 custom models and
50 MiB of custom-model data in total. If either live-upload limit is reached,
delete an unused model before uploading another; existing models can always be
downloaded or deleted.

Restored state has a separate, immutable safety envelope: a 1 MiB registry,
at most 100 records, no model over 5 MiB, and no more than 50 MiB of model data
in total. The wider record limit preserves legitimate state accepted by an
earlier release if live policy is later lowered. Pictaria checks that envelope
before opening or hashing any restored model, and backups apply the same
limits. Duplicate registry identities and unbounded metadata shapes are
rejected rather than multiplying startup or backup work.

The easiest way to create one is
**[openwakeword.com](https://openwakeword.com)**: type your phrase, preview it
with synthetic voices, and the site trains a model on cloud GPUs — no ML
expertise or voice recordings needed, usually done in under an hour. Download
the **`.tflite`** version of the finished model; the site also offers an ONNX
variant, which Pictaria does not accept. The service is built on the same
open-source openWakeWord library Pictaria's detector uses.

The text entered as the model's **Spoken phrase** is descriptive metadata. It
does not train, modify, or correct the model. The audio phrase the detector
recognizes is determined entirely by the uploaded model.

The supported public creation path is openWakeWord's official
[automatic model-training notebook](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing):

1. Open the notebook in Google Colab and run its environment-setup cells.
2. Set `target_phrase` to the phrase you want to recognize and set a unique
   `model_name`.
3. Run the data-generation and training cells through the conversion step.
4. Download `my_custom_model/<model_name>.tflite`.
5. Upload that `.tflite` file to Pictaria Server.

The notebook produces both ONNX and TensorFlow Lite outputs. Pictaria accepts
only the `.tflite` classifier; an `.onnx` file cannot be uploaded directly.
The upload validator is the final compatibility check: do not assume that an
arbitrary TensorFlow Lite or openWakeWord-labeled file uses Pictaria's
`[1, frames, 96]` feature contract.

The official notebook is intended as a convenient baseline, not a guarantee
of recognition quality. Advanced users can use openWakeWord's detailed
training workflow, provided the final classifier satisfies the same contract.

Before uploading, test the model outside Pictaria if the model provider offers
that capability. Structural compatibility does not guarantee good detection
quality, pronunciation coverage, or resistance to false activations.

### 2. Upload the model to Pictaria Server

1. Open the Pictaria Server web interface.
2. Sign in with the server app password.
3. Open **Settings → Wake Words**.
4. Enter the fields described below.
5. Select the `.tflite` file.
6. Confirm that you have the right to use the model.
7. Select **Upload model**.

The server validates the model before adding it to the list. A successful
upload makes the model available to connected frames; it does not install or
activate it automatically.

| Field | Meaning |
| --- | --- |
| **Name shown in Pictaria Frame** | A friendly administrative label, such as “Hey Kitchen.” It does not affect recognition. |
| **Spoken phrase** | The words people should say. This is displayed to users but does not alter the model. |
| **Default detection threshold** | The initial score required to trigger detection. `0.5` is a reasonable starting point. |
| **Model file** | A compatible `.tflite` file no larger than 5 MiB. |
| **Rights confirmation** | Confirmation that you are authorized to use and distribute the model to your own frames. |

Uploading identical model bytes twice is rejected. To publish a genuinely new
version, upload the new model file as a new entry.

### 3. Install and select it on a frame

Repeat these steps on every frame that should use the custom phrase:

1. Open **Settings** on the frame.
2. Confirm the Pictaria Server URL and app password are correct.
3. Enable **Voice Commands**.
4. Under **Wake Phrase**, select **Refresh Available Wake Phrases**.
5. Select the desired custom model.
6. Wait for the app to report that the model is installed.
7. Select **Save Settings**.
8. Return to the slideshow and wait for **Voice ready**.

The frame authenticates to Pictaria Server, downloads the selected model,
verifies it, performs a native TensorFlow Lite smoke test, and installs it in
app-private storage. Other models in the server registry are not downloaded.

### 4. Test it

Test from the distance and room position where the frame will normally be
used:

1. Wait until the slideshow reports **Voice ready**.
2. Say the custom phrase naturally.
3. Wait for the listening state, then speak a supported command.
4. Repeat with several voices, volumes, and positions.
5. Also leave the device in a room with ordinary conversation, television,
   and music to look for false activations.

Before deploying a new model broadly, use this minimum acceptance check on a
real frame:

1. Use every regular speaker in the household, up to at least three people.
2. Have each person make 10 attempts from about 1 meter and 10 attempts from
   the normal room position, split between a quiet room and typical
   background sound.
3. Require at least 90% detection overall and at least 80% for every person
   and test condition.
4. Say 20 similar or easily confused phrases that should *not* activate the
   frame. More than one activation is a reason to raise the threshold or
   retrain.
5. Run at least two hours of ordinary television, music, and conversation.
   More than one unintended activation is a reason to tune or replace the
   model.
6. After any threshold change, repeat both the positive and negative checks.

These are practical release gates, not a performance warranty. A household
with higher sensitivity to false activations should require zero false
activations during a longer soak.

### 5. Tune the threshold

Each frame stores its own threshold for the selected custom model.

- **Raise the threshold** to reduce false activations. This can make quiet or
  distant phrases easier to miss.
- **Lower the threshold** to make detection more sensitive. This can increase
  false activations.

Use small changes, such as `0.05` at a time, and retest under normal room
conditions. The supported range is `0.05` through `0.94`.

A threshold cannot make a poorly trained or incompatible model reliable. If
large adjustments are necessary, improve or retrain the model instead.

## Model compatibility

The current compatibility identifier is:

```text
pictaria-openwakeword-v1
```

A compatible classifier must satisfy all of the following:

| Property | Requirement |
| --- | --- |
| File | TensorFlow Lite FlatBuffer with `TFL3` identifier |
| TensorFlow Lite schema | Version 3 |
| Inputs | Exactly one |
| Input type | `float32` |
| Input shape | `[1, frames, 96]` |
| Input frames | 1 through 120 |
| Outputs | Exactly one |
| Output type | `float32` |
| Output elements | Exactly one scalar score |
| File size | 1 byte through 5 MiB |

The `96`-element vectors are embeddings generated by Pictaria's bundled
openWakeWord-compatible feature pipeline. A `.tflite` file can be a valid
TensorFlow Lite model and still be incompatible with this pipeline.

The server checks the FlatBuffer structure before accepting an upload. Android
then opens the model with the TensorFlow Lite runtime, repeats the tensor
checks, runs a zero-input inference, and requires a finite output score before
installation. These checks establish that the model is safe and executable;
they cannot establish that it recognizes the intended phrase well.

## Licensing and model rights

Pictaria Server does not grant a license to models uploaded by an
administrator. Before uploading a model, confirm that its license permits the
intended use and installation on all connected frames.

Consider separately:

- commercial versus non-commercial use;
- personal use versus distribution to other people or organizations;
- rights to the trained model, training service output, datasets, and any
  bundled feature components;
- attribution, notice, or share-alike requirements;
- whether a license permits including the model in a backup or moving it to
  another device.

The server records the time at which the uploader confirmed model rights.
This is an administrative record, not independent license verification.

By selecting the rights-confirmation checkbox, the administrator confirms
that they have the rights needed to use the model, copy it to every connected
frame, and include it in Pictaria backups. Pictaria does not grant, sublicense,
or independently verify rights in an uploaded model.

The openWakeWord software and a trained wake-word model may have different
licenses. In particular, an Apache-licensed training tool or runtime does not
automatically make every model produced by or distributed with it suitable
for commercial use. Check the license and terms attached to the exact model
file, including whether it was trained under your own account or downloaded
from a community library.

Third-party or demonstration wake models are not included with Pictaria unless
Pictaria has the appropriate distribution and commercial rights. Internal QA
models must not be placed in release images or public downloads without a
separate license review.

The built-in “Hey Pictaria” model is separately licensed by Pictaria for
commercial distribution in Pictaria Frame. Users do not need to obtain a
separate license for that bundled model. That license does not extend to
models an administrator uploads.

## Offline behavior, updates, and deletion

### Offline operation

After installation, the selected model and its SHA-256 identity are stored
privately on the frame. Wake-word inference is local and does not stream
always-on microphone audio to Pictaria Server.

The server is still required for later model discovery or download. Speech
recognition and command handling may also require network services depending
on the configured voice features.

### Replacing a model

There is no in-place model editing API. Treat model bytes as immutable:

1. Upload the new `.tflite` file as a new server entry.
2. Refresh Available Wake Phrases on a test frame.
3. Select, save, and validate the new model.
4. Roll it out to the remaining frames.
5. Delete the retired server entry only after migration is complete.

The server rejects a second upload with the same SHA-256 hash.

### Deleting a server model

Deleting a model removes it from Pictaria Server and prevents new downloads.
It does **not** remotely deactivate frames that already installed it. An
already configured frame can continue using its validated local copy.

To retire a model, change the Wake Phrase on every affected frame to “Hey
Pictaria” or another custom model. Selecting a different phrase stops using
the retired model. The current app does not expose a separate “purge all
downloaded models” control.

For the `1.0` release, model retirement is deliberately a per-frame
administrative operation; there is no remote revocation or model-purge
control. If the model bytes themselves must be removed from a device, first
select and save “Hey Pictaria,” then clear Pictaria Frame's Android app
storage or reinstall the app. Clearing app storage also removes the frame's
other local settings and requires onboarding again.

### Automatic fallback

If a selected custom model is missing, corrupted, fails its startup SHA-256
check, or cannot initialize in TensorFlow Lite, the frame starts the bundled
“Hey Pictaria” detector. The slideshow reports:

```text
Custom wake phrase unavailable; using “Hey Pictaria”.
```

This fallback keeps voice usable, but administrators should still correct the
custom-model problem rather than rely on fallback indefinitely.

## Troubleshooting

### The custom model does not appear on the frame

- Confirm the frame has Pictaria Connect access.
- Confirm its Pictaria Server URL and app password.
- Confirm the server and frame versions support custom wake-word models.
- Check that the model is shown as available under **Server Settings → Wake
  Words**.
- Select **Refresh Available Wake Phrases** again.
- Verify the frame can reach the server over the local network.

### The server rejects the upload

Read the validation message in Settings. Common causes include:

- the file is not named `.tflite`;
- the file is larger than 5 MiB;
- it is not a TensorFlow Lite schema-version-3 model;
- it has the wrong tensor count, type, or shape;
- the model was already uploaded under another name;
- a required name, phrase, threshold, or rights confirmation is missing.

If the model came from a training service, confirm that you downloaded the
openWakeWord TensorFlow Lite classifier rather than an ONNX model, feature
model, audio sample, archive, or another export format.

For the supported openWakeWord notebook, use the file named
`my_custom_model/<model_name>.tflite` from the final training output. Do not
upload its neighboring `.onnx` file. A commercial training service is
supported only when it supplies a `.tflite` classifier that passes the model
requirements above; service names, account licenses, and marketing claims are
not substitutes for Pictaria's upload validation.

### The model uploads but installation fails

The Android runtime applies stricter checks than the server:

- authenticated download;
- exact byte count;
- SHA-256 match;
- successful TensorFlow Lite interpreter creation;
- matching tensor contract;
- successful smoke inference with a finite score.

Check the frame's on-screen error, confirm adequate free storage, and retry
the download. If “Hey Pictaria” starts automatically, the custom model did not
pass activation.

For support without Android Debug Bridge, collect:

- the exact on-screen error or a screenshot;
- the model's displayed name, spoken phrase, file size, and threshold from
  **Server Settings → Wake Words**;
- the frame's device name;
- the Pictaria Frame version and build shown under **Settings → About &
  Licenses**;
- the Pictaria Server version from its authenticated `/api/health` response;
- whether **Test Connection**, **Refresh Available Wake Phrases**, and the
  built-in “Hey Pictaria” phrase work;
- whether the failure occurs during refresh, download, installation, startup,
  or detection.

If the user has opted into **Settings → Diagnostics → Crash Reports**, ask
them to reproduce the failure once and include its approximate time. Never
ask for or share an Immich API key, Pictaria Server password, model file, private
server address, or household audio in a public support report.

### The model installs but never activates

- Confirm the slideshow says **Voice ready**.
- Grant microphone permission.
- Confirm Voice Commands remains enabled after saving Settings.
- Verify that the displayed spoken phrase matches the phrase used to train
  the model.
- Lower the threshold in small increments.
- Test closer to the device and without background noise.
- If it still fails, retrain or replace the model.

Successful structural validation does not measure recognition quality.

### The model activates too often

- Raise the threshold in small increments.
- Test with television, music, nearby conversation, and words that sound
  similar to the desired phrase.
- Prefer a longer or more distinctive phrase when retraining.

### Deleting the model did not stop a frame

This is expected for an already installed model. Deletion prevents future
downloads but does not revoke local copies. Select “Hey Pictaria” or another
model on that frame and save Settings.

### The frame says it is using “Hey Pictaria”

The custom model failed to start and the safety fallback is active. Reopen
Settings, refresh the model list, and reinstall or choose a different model.

## Storage and backups

The model registry is stored under `WAKE_WORD_MODELS_DIR`.

| Installation | Default path |
| --- | --- |
| Bare Node | `data/wake-word-models` |
| Docker image | `/data/wake-word-models` |

The directory contains:

```text
wake-word-models/
├── registry.json
├── registry.json.bak
└── models/
    └── <model-uuid>.tflite
```

- `registry.json` is the authoritative metadata registry.
- `registry.json.bak` is the previous registry snapshot written before a
  registry replacement. It is not a substitute for normal backups.
- Model filenames use server-generated UUIDs; the original upload filename is
  retained as metadata.
- The server creates directories with owner-only permissions and writes
  registry/model files with owner-only permissions where supported.
- On startup, the server audits registered model files for presence and size.
- Every download repeats the exact size and SHA-256 integrity check.

Do not hand-edit the registry or rename model files. Use the web interface or
API.

Automatic Pictaria backups include the complete custom model directory. These
files may be irreplaceable if the original training output is lost, so point
`BACKUP_DIR` at durable storage and retain the original model separately when
possible. See [BACKUP.md](BACKUP.md) for backup and restore procedures.

To override the directory:

```dotenv
WAKE_WORD_MODELS_DIR=/path/to/persistent/wake-word-models
```

For Docker, keep this path inside a persistent volume. The stock image uses
`/data/wake-word-models`. The configured root may itself resolve through a
symbolic link, bind mount, or volume. Pictaria pins that operator-selected
directory, while refusing links or multi-linked files substituted inside it.
If an internal storage entry is unsafe, custom-model operations return a
service-unavailable error and the server warns without changing the suspect
data; built-in “Hey Pictaria” support remains available. Missing registry data
or a recorded model that fails its SHA-256 check is treated as protected-state
loss and must be restored rather than silently replaced.

## Security and integrity model

The custom-model path is designed so that JavaScript never chooses an
arbitrary native file for inference:

1. The authenticated server manifest supplies a UUID, byte count, SHA-256,
   compatibility identifier, and relative download path.
2. The app rejects malformed manifests and download paths.
3. The app downloads into its private cache with the configured app-password
   header.
4. Native Android code resolves the cache URI, limits the copy to 5 MiB,
   verifies exact size and SHA-256, validates tensors, and performs a real
   TensorFlow Lite inference.
5. Only then is the file promoted into app-private model storage.
6. Starting a custom detector resolves the file internally from its UUID and
   hash and rehashes it before use.
7. A failure starts the packaged “Hey Pictaria” model instead.

Server downloads are authenticated and return immutable caching headers
because a model UUID and recorded SHA-256 identify immutable bytes.

## HTTP API

Pictaria Frame uses these endpoints. All are covered by the normal Pictaria
Server authentication policy.

When `APP_PASSWORD` is configured, programmatic clients authenticate with
either:

```http
X-App-Password: <password>
```

or:

```http
Authorization: Bearer <password>
```

The browser Settings interface uses its authenticated session cookie.

### Endpoints

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/frame/wake-word-models` | Versioned manifest of all registered models |
| `POST` | `/api/frame/wake-word-models` | Validate and create a model entry |
| `GET` | `/api/frame/wake-word-models/:id/download` | Download immutable `.tflite` bytes |
| `DELETE` | `/api/frame/wake-word-models/:id` | Remove the server entry and server-side file |

### List models

Example response:

```json
{
  "featureStack": "pictaria-openwakeword-v1",
  "models": [
    {
      "id": "3c049015-46a6-4ebb-b9c1-d3d7543daa98",
      "displayName": "Hey Kitchen",
      "phrase": "Hey Kitchen",
      "defaultThreshold": 0.5,
      "filename": "hey_kitchen.tflite",
      "byteSize": 1278912,
      "sha256": "<64 lowercase hexadecimal characters>",
      "createdAt": "2026-07-23T00:00:00.000Z",
      "updatedAt": "2026-07-23T00:00:00.000Z",
      "rightsConfirmedAt": "2026-07-23T00:00:00.000Z",
      "featureStack": "pictaria-openwakeword-v1",
      "inputFrames": 16,
      "embeddingDimension": 96,
      "available": true,
      "unavailableReason": null,
      "downloadPath": "/api/frame/wake-word-models/3c049015-46a6-4ebb-b9c1-d3d7543daa98/download"
    }
  ],
  "version": 1
}
```

The response uses `Cache-Control: no-store`. A registered model whose file is
missing or fails a server audit remains visible with `available: false` and an
`unavailableReason`.

### Upload a model

Uploads use JSON rather than multipart form data:

```json
{
  "displayName": "Hey Kitchen",
  "phrase": "Hey Kitchen",
  "defaultThreshold": 0.5,
  "filename": "hey_kitchen.tflite",
  "modelBase64": "<standard padded base64>",
  "rightsConfirmed": true
}
```

Limits:

- model name: required, at most 60 characters;
- spoken phrase: required, at most 100 characters;
- original filename: required, at most 120 characters, ending in `.tflite`;
- threshold: `0.05 <= value < 0.95`;
- decoded model: at most 5 MiB;
- complete JSON request body: at most 8 MiB;
- base64 must use the standard padded alphabet.

A successful upload returns `201` and the created model object. Uploading the
same SHA-256 content again returns `409`.

### Download a model

A successful download returns:

```http
Content-Type: application/vnd.tflite
Content-Disposition: attachment; filename="wake-word-model.tflite"
Cache-Control: private, max-age=31536000, immutable
ETag: "sha256-<sha256>"
X-Content-SHA256: <sha256>
```

Before responding, the server reads the file and verifies its exact byte count
and SHA-256 against the registry.

### Delete a model

A successful deletion returns `204 No Content`. An unknown UUID returns `404`.
Deletion has no remote-revocation semantics for frames that already installed
the model.

### Error format

API errors are JSON:

```json
{
  "error": {
    "code": "invalid_wake_word_model",
    "message": "Wake-word input must have shape [1, frames, 96] with frames between 1 and 120."
  }
}
```

Relevant errors include:

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_wake_word_model` | Upload metadata, base64, or model structure is invalid |
| `400` | `invalid_wake_word_model_id` | Path does not contain a valid model UUID |
| `401` | `unauthorized` | App password is missing or incorrect |
| `404` | `wake_word_model_not_found` | Registry entry does not exist |
| `409` | `duplicate_wake_word_model` | Identical model content is already registered |
| `409` | `wake_word_model_unavailable` | Registered bytes are missing or fail integrity checking |
| `413` | `payload_too_large` | Complete JSON body exceeds 8 MiB |
| `500` | `wake_word_registry_unreadable` | Persistent registry cannot be parsed or validated |

## Implementation map

Server:

- `src/routes/wakeword.mjs` — authenticated HTTP routes and upload validation
- `src/wakeword/modelInspector.mjs` — safe, minimal TensorFlow Lite structural
  inspection
- `src/wakeword/store.mjs` — persistent registry, serialized writes, file
  integrity, and deletion
- `src/protocol.mjs` — `custom-wake-word-models` capability declaration
- `src/backup.mjs` — backup inclusion
- `public/settings.html` — administrative upload/list/delete interface

Frame:

- `src/services/voice/wakeWordManifest.ts` — strict manifest boundary
- `src/services/voice/wakeWordModels.ts` — authenticated temporary download and
  native installation
- `src/services/voice/useWakeWordListener.ts` — activation and safe fallback
- `android/app/src/main/java/com/local/photoframe/OpenWakeWordModule.kt` —
  private storage, hash verification, interpreter validation, smoke inference,
  and native model resolution
- `android/app/src/main/java/com/local/photoframe/OpenWakeWordDetector.kt` —
  audio feature pipeline and continuous wake-word inference

## Release scope

- Custom wake phrases are supported on Android only. No non-Android release
  or schedule is currently announced.
- Model retirement is per-frame in the `1.0` release. Server deletion prevents
  discovery and new downloads but does not remotely revoke an installed copy.
- The bundled “Hey Pictaria” model is the supported default and safety
  fallback.
- User documentation is available from the server's **Documentation** link,
  the server README and first-run checklist, and the Pictaria Frame Guide.
