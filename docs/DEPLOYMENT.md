# Subcast Deployment

This guide covers running Subcast as a long-running local service. The default `pnpm dev` mode is for active development; for a "set it and forget it" setup, build the production bundle and run it under your platform's service manager.

## 1. Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` produces `.output/` containing a self-contained Nitro server. Copy the project (or just `.output/` + `node_modules/nodejs-whisper`'s built whisper.cpp + downloaded models) wherever you want to run.

## 2. Runtime requirements on the deployment host

- Node.js 22+ on PATH
- `ffmpeg` + `ffprobe` on PATH
- A locally accessible Ollama instance (`http://localhost:11434` by default; override via `SUBCAST_OLLAMA_URL`)
- The Ollama model named in Settings is pulled (`ollama pull qwen2.5:7b`)
- The whisper-cli binary built under `node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli` (the `.output/` bundle alone is **not** enough — it relies on the package layout)

## 3. Environment variables

| Var | Default | Purpose |
|---|---|---|
| `NUXT_HOST` | `0.0.0.0` | bind address |
| `NUXT_PORT` | `3000` | port |
| `SUBCAST_OLLAMA_URL` | `http://localhost:11434` | Ollama HTTP endpoint |
| `SUBCAST_OLLAMA_MODEL` | (unset → use Settings default) | force a specific Ollama tag |

## 4. Run

```bash
node .output/server/index.mjs
```

The first request to `/api/transcribe` or `/api/translate` may be slow if a model needs to load into Ollama (~10 s) or if a Whisper chunk's first inference hasn't run yet.

## 5. Service manager examples

### macOS — launchd

`~/Library/LaunchAgents/com.subcast.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.subcast</string>
  <key>WorkingDirectory</key><string>/Users/you/Code/subcast</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>.output/server/index.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SUBCAST_OLLAMA_MODEL</key><string>qwen2.5:7b</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/subcast.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/subcast.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.subcast.plist
launchctl start com.subcast
```

### Linux — systemd

`/etc/systemd/system/subcast.service`:

```ini
[Unit]
Description=Subcast local subtitle service
Requires=ollama.service
After=ollama.service

[Service]
WorkingDirectory=/opt/subcast
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=on-failure
Environment=SUBCAST_OLLAMA_MODEL=qwen2.5:7b
User=subcast
Group=subcast

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now subcast.service
sudo journalctl -u subcast.service -f
```

## 6. Storage layout

`~/.subcast/` (the running user's home) holds everything user-visible:

- `videos/` — original uploads (one copy per unique SHA-256, regardless of source filename)
- `cache/{sha}/` — generated VTT + meta per video
- `logs/YYYY-MM-DD.jsonl` — structured logs, sanitized by default; rotated daily and pruned > 14 days
- `data.sqlite` — task / queue / settings state

Back up `~/.subcast/` if you want to preserve transcriptions across machine moves. SHA-keyed paths mean a backup is portable.

## 7. Network considerations

The default bind `0.0.0.0` means **any device on the same LAN** can connect to port 3000. There's no auth — Subcast trusts the local network. If your network isn't trusted (public WiFi, shared office), restrict the port at your firewall:

```bash
# macOS
sudo pfctl -e
echo "block in proto tcp from any to any port 3000" | sudo pfctl -f -

# Linux (UFW)
sudo ufw allow from 192.168.0.0/16 to any port 3000
sudo ufw deny 3000
```

## 8. Updating

When you pull a new version that includes a schema migration, the next process start will run it automatically — `data.sqlite` migrations are idempotent and additive. No manual `db migrate` step.

For a major Whisper model bump, re-download the model:

```bash
npx --no-install nodejs-whisper download large-v3
```

Or trigger from Settings → Whisper model → Save → follow the banner.

## 9. Troubleshooting

| Issue | Hint |
|---|---|
| Server up but `/api/transcribe` 500 | check `~/.subcast/logs/<today>.jsonl` for stack traces |
| `ENOSPC` writing chunks | cache hit your `cacheLimitGB` — wipe via Settings or raise the limit |
| Whisper output corrupted on long videos | try a larger model; or look for hallucination repeats — they get auto-marked `quality='suspect'` |
| Ollama times out | larger models need more RAM; pick a smaller `ollamaModel` or upgrade hardware |
| Browser can't seek a long video | reverse proxy in front of Subcast must pass through the `Range` request header |

## 10. Diagnostic bundle

When asking for help, include the ZIP from **Settings → Diagnostic → Export ZIP** or:

```bash
curl -OJ http://localhost:3000/api/diagnostic
```

The ZIP contains: settings, hardware info, installed Whisper / Ollama models, and the last 7 days of JSONL logs (paths/filenames hashed unless `debugMode` is on). It does **not** contain video content or cue text.
