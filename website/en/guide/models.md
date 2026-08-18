# Model Management

Manage everything in Settings → Models.

## Transcription engines

- **SenseVoice** (250 MB): bundled with the installer and seeded on first launch; re-downloadable from Settings after deletion;
- **Whisper** (77 MB – 1.6 GB): five on-demand tiers — tiny / base / small / medium / large-v3-turbo. Existing GGUFs from LM Studio or Jan can be symlinked (zero extra disk).

## AI translation models (Qwen3)

| Tier | Size | Recommended RAM |
|---|---|---|
| 4B | 2.5 GB | 8 GB |
| 8B | 5.0 GB | 16 GB |
| 14B | 9.0 GB | 32 GB |

Settings recommends a tier based on your RAM. Upgraders from Qwen 2.5 can clean up old model files from Settings in one click.

## Runtime status

Settings shows transcription model runtime and AI model runtime separately. Transcription covers SenseVoice / Whisper; AI covers Qwen3 translation, transcript polish and AI summaries.

`Running` means the model is actively processing work. `Loaded` means the model is still in memory and will auto-release after being idle. This helps explain whether fan noise, memory use or an active task is coming from Subcast.

## Storage location

`~/Library/Application Support/Subcast/models/` (macOS). Deleting a model never affects completed transcripts or translation caches.
