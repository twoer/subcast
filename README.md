# Subcast

> Sub + Cast — fully-local multilingual subtitle player.

Drop a video → local Whisper transcription → browser playback with on-the-fly translation. **No internet, no paid APIs, no telemetry. All data stays on the box.**

## Highlights

- 🔒 **Privacy-first** — all data and inference local
- 💸 **Zero cost** — no cloud APIs
- 🌍 **Multilingual** — original + arbitrary target languages, switch live
- ⚡ **Streaming UX** — watch while transcription is still running
- ↩️ **Resume-safe** — kill the process mid-transcribe; it picks up from the last completed 30s chunk
- 🚦 **Adaptive** — first-boot picks Whisper + Ollama models from your hardware tier

## Stack

- **Nuxt 4** + Vue 3 + TypeScript (strict) + Tailwind CSS
- **whisper.cpp** via `nodejs-whisper` (transcription)
- **Ollama** + `qwen2.5:7b` (translation; configurable)
- **better-sqlite3** + filesystem cache under `~/.subcast/`

## Prerequisites

| Dependency | Why |
|---|---|
| Node.js 22+ | Nuxt 4 / Nitro 2 runtime |
| pnpm 9+ | package manager (yarn / npm should work too) |
| ffmpeg + ffprobe | audio extraction & duration probe |
| cmake + a C++ toolchain | first-time `whisper-cli` build |
| Ollama running locally | `http://localhost:11434` |

macOS quick install:

```bash
brew install node pnpm ffmpeg cmake ollama
ollama serve         # in a separate terminal
ollama pull qwen2.5:7b
```

Linux:

```bash
sudo apt install ffmpeg cmake build-essential
curl -fsSL https://ollama.com/install.sh | sh && ollama serve &
ollama pull qwen2.5:7b
```

## First-time setup

```bash
git clone <this repo>
cd subcast
pnpm install

# Build the whisper-cli binary that nodejs-whisper expects (one-time)
cd node_modules/nodejs-whisper/cpp/whisper.cpp/build
cmake --build . --target whisper-cli -j
cd -

# Download a Whisper model (interactive picker; choose 'base' to start small)
npx --no-install nodejs-whisper download
```

If anything is missing, the home page shows a yellow banner with the exact command for your platform — you can ignore the steps above and let the banner guide you.

## Run

```bash
pnpm dev
```

Open http://localhost:3000. The default network bind is `0.0.0.0`, so any device on the same LAN can hit `http://<your-host>:3000` (the home page surfaces the LAN URL).

To pin a specific Ollama model from the shell (overrides first-boot recommendation):

```bash
SUBCAST_OLLAMA_MODEL=qwen2.5:7b pnpm dev
```

## Storage

Everything user-visible lives under `~/.subcast/`:

```
~/.subcast/
├── videos/{sha256}.{ext}         # uploaded video copies
├── cache/{sha256}/
│   ├── original.vtt              # transcribe output
│   ├── zh-CN.vtt                 # translation per BCP-47 lang
│   └── meta.json                 # cue count + timestamps
├── logs/YYYY-MM-DD.jsonl         # structured logs (14d rotation)
├── data.sqlite                   # tasks + chunks + subtitles + settings
└── tmp/                          # ffmpeg scratch / multipart staging
```

Clear cache from **Settings** (per-video or full wipe) or via API:

```bash
curl -X DELETE http://localhost:3000/api/cache/<sha256>
curl -X DELETE http://localhost:3000/api/cache/clear
```

## Settings

`/settings` exposes:

- **Whisper model** — `tiny / base / small / medium / large-v3`. First-boot picks based on your hardware tier (entry / standard / recommended / high).
- **Ollama model** — exact tag (e.g., `qwen2.5:7b`). Recommendation also follows hardware tier.
- **Cache size limit** — UI warns when usage ≥ 90 %.
- **Silence threshold** — gaps ≥ this duration get a 「── no audio ──」divider in the cue list (UI-only; not in VTT).
- **Debug mode** — keep raw paths/filenames in JSONL logs (default: hashed).

Settings are persisted in `~/.subcast/data.sqlite` (`settings` table) and apply to **future** tasks.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/upload` | Upload video (+optional `subtitle` companion file) |
| GET | `/api/transcribe?hash=` | SSE: stream cues; replays from cache when ready |
| GET | `/api/translate?hash=&lang=` | SSE: translate to `lang` (BCP-47); replays from cache |
| GET | `/api/video?hash=` | Range-supported video streaming (for `<video>`) |
| GET | `/api/queue/list` | Current + recent tasks (transcribe + translate) |
| DELETE | `/api/queue/transcribe/:id` | Cancel transcribe task |
| DELETE | `/api/queue/translate/:id` | Cancel translate task |
| GET | `/api/cache/list` | List cached videos with size + langs |
| DELETE | `/api/cache/:hash` | Wipe one cached video |
| DELETE | `/api/cache/clear` | Wipe all caches |
| GET | `/api/health` | Hardware + ollama + whisper readiness |
| GET | `/api/settings` / PUT | Read/write settings |
| GET | `/api/diagnostic` | ZIP bundle (sanitized logs + settings + hw + models) |

## Keyboard shortcuts (player page)

| Keys | Action |
|---|---|
| Space / K | Play / Pause |
| ← / → | Seek -/+ 5s |
| J / L | Seek -/+ 10s (YouTube-style) |
| ↑ / ↓ | Volume ±10% |
| < / > | Speed ±1 step (0.5/0.75/1/1.25/1.5/1.75/2) |
| M / F / C | Mute / Fullscreen / Subtitles |
| 1-9 | Jump to 10%-90% of duration |
| ? | Open shortcut help |
| Esc | Close any dialog |

## Development

```bash
pnpm dev            # start dev server
pnpm test           # vitest unit tests
pnpm typecheck      # nuxt typecheck (slow first run)
pnpm build          # production build (.output/)
```

Architecture notes:

- **Streaming queue model** — both transcribe and translate are SQLite-backed single-concurrent queues. SSE handlers are thin shims over `queue.attach(taskId)` which yields history-replay then live frames; restart-safe because chunks persist between Nitro processes.
- **Hallucination retry ladder** — every 30s chunk goes through up to 3 attempts (temperature 0 → 0.4 → 0.8, no-context after attempt 1) and is marked `quality='suspect'` in UI if all three fail. See `server/utils/quality.ts`.
- **Translate retry ladder** — 40-cue super-batches drop to 15-cue sub-batches on count mismatch, then per-cue. See `server/utils/ollama.ts`.
- **Imported subtitles** — companion `.srt/.vtt/.ass` files write directly to `cache/{sha}/original.vtt` and create a faux `transcribe_tasks` row marked `model='imported'` so existing replay logic just works.

See `docs/superpowers/specs/2026-05-09-subcast-design.md` for the full design spec; `docs/superpowers/plans/2026-05-09-subcast-slice-1-walking-skeleton.md` for the original walking-skeleton plan.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `whisper-cli executable not found` | run the cmake build under `node_modules/nodejs-whisper/cpp/whisper.cpp/build` |
| `OLLAMA_UNREACHABLE` | `ollama serve` not running, or override `SUBCAST_OLLAMA_URL` |
| `MODEL_NOT_PULLED` | `ollama pull <model>` (or change `ollamaModel` in Settings) |
| Translation produces variable / hallucinated output | use `qwen2.5:7b` (or larger) instead of generic models like Llama |
| `<video>` won't seek | server must support Range; ours does — but reverse proxies may strip headers |

## License

TBD (see Spec §9 待决策项 — MIT / Apache 2.0 / GPL).
