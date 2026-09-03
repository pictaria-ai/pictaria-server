# Recommended AI models

**Last reviewed: August 19, 2026**

These are practical starting points from the Pictaria owner's reference
installation, not a permanent compatibility list. Model availability,
capability, quality, price, and privacy terms change quickly. Confirm the
current model entry and provider policy before processing a private photo
library, and test a small Enrich run before committing to a large one.

Pictaria does not proxy model traffic: local models stay on hardware you
control, while a cloud choice sends the request directly from Pictaria Server
to the provider configured with your own account. See the
[Pictaria privacy policy](https://pictaria.ai/privacy) and the linked provider
documentation below.

## Current role-by-role starting point

| Pictaria role | Provider | Exact model identifier | Runs | Why / required capability |
| --- | --- | --- | --- | --- |
| Enrich | Venice | `qwen3-vl-235b-a22b` | Cloud | Vision plus structured output. The current Venice catalog marks this model Private; recheck that status before use. |
| Curate AI referee | Venice | `qwen3-vl-235b-a22b` | Cloud | Vision, structured output, and multiple images in one request. The reference installation leaves the referee set to **Follow Enrich provider**, so it uses this same model. |
| Voice photo answers (Interesting) | OpenAI | `gpt-5.5` | Cloud | Accepts image input and structured output. The model is chosen under Settings → Voice TTS. |
| Voice general questions (Ask) | OpenAI | `gpt-5.4-nano` | Cloud | A small, fast text model for a command whose answer is spoken while someone waits. |
| Text to speech | OpenAI | `gpt-4o-mini-tts` | Cloud | Purpose-built speech output; voice, speed, and format remain separate choices under Settings → Voice TTS. |

Provider references:

- Venice's [model catalog](https://docs.venice.ai/models/overview) lists
  `qwen3-vl-235b-a22b` and its current capabilities. Venice's
  [privacy guide](https://docs.venice.ai/overview/privacy) explains that a
  model marked `private` uses contract-enforced zero data retention, while
  `anonymized` hides identity but still exposes request content to the model
  provider.
- OpenAI documents the modalities and features for
  [`gpt-5.5`](https://developers.openai.com/api/docs/models/gpt-5.5),
  [`gpt-5.4-nano`](https://developers.openai.com/api/docs/models/gpt-5.4-nano),
  and
  [`gpt-4o-mini-tts`](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts).

## Local and alternate starting points

The same reference installation keeps these provider-default models configured
for comparison. They are useful starting points, but being listed here does
not mean every role or hardware profile has been benchmarked with them.

| Provider | Exact model identifier | Runs | Suitable starting use |
| --- | --- | --- | --- |
| LM Studio | `qwen3-vl-32b-instruct-mlx` | Local | Enrich or Interesting on a capable Apple-silicon Mac. This is the reference installation's API identifier; LM Studio identifiers can be assigned locally, so use exactly what your server reports. |
| Ollama | `qwen3-vl:8b` | Operator-hosted | A smaller vision model for Enrich or Interesting. It is the easiest no-third-party-cloud starting point and needs Ollama 0.12.7 or newer. |
| OpenRouter | `qwen/qwen3-vl-32b-instruct` | Cloud | Vision-capable Enrich alternative with structured-response support. |
| Ollama Cloud | `qwen3.5:cloud` | Cloud | Multimodal Enrich alternative. |

The **OpenAI-compatible** entry in Settings is an endpoint adapter, not a
separate model recommendation. It is intended first for llama.cpp and similar
servers: use the exact identifier that endpoint accepts, verify that the model
supports images (and multiple images for the Curate referee), and run a small
Enrich test before a library sweep. Current llama.cpp accepts JPEG/PNG-style
stb_image inputs rather than WebP, so set Pictaria's Image source to
**original** for that setup.

The upstream references are LM Studio's
[identifier guidance](https://lmstudio.ai/docs/cli/local-models/load), Ollama's
[`qwen3-vl`](https://ollama.com/library/qwen3-vl) and
[`qwen3.5:cloud`](https://ollama.com/library/qwen3.5:cloud) model pages, and
OpenRouter's
[`qwen/qwen3-vl-32b-instruct`](https://openrouter.ai/qwen/qwen3-vl-32b-instruct)
entry, and llama.cpp's
[server guide](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

## Where each value goes

- **Settings → AI Providers** holds reusable connections, credentials,
  endpoints, and each provider's default model. Local Models and Cloud Models
  are separated there.
- The **Enrich page** chooses the provider for new enrichment runs. The choice
  is remembered across visits and restarts.
- **Settings → Curate** may follow the Enrich provider or override both the
  referee provider and model.
- **Settings → Voice TTS** chooses the voice-answer provider, Interesting
  and Ask models, TTS provider, voice, model, and output options.
- The ElevenLabs API key is under **AI Providers** because it is a reusable
  connection credential. It is used only for TTS; its voice, model, and output
  format stay under **Voice TTS**.

Environment variables remain supported. A saved UI value overrides its
environment counterpart until the saved value is cleared; the active Enrich
provider is the remembered Enrich-page choice, with `DEFAULT_PROVIDER` used
only when no choice has yet been saved.
