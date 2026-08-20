# FAQ

## The app is reported as "damaged" on first launch

That's macOS Gatekeeper blocking an unsigned app — it isn't actually damaged. Run in Terminal:

```bash
xattr -cr /Applications/Subcast.app
```

## Does my data ever leave my computer?

No. Transcription, translation, and summaries all run locally. Model downloads need the network once; everything after is offline. No telemetry, no reporting.

## Is AI Assistant access safe?

It is off by default. You enable it manually in Settings → AI Assistant, authorization is valid only for the current Subcast session, and it expires when the app quits. Subcast's MCP / agent APIs return redacted status, hash prefixes, and next actions; they never ask you to paste a desktop session token into chat.

## What is a media pack?

A media pack is structured material for people and AI agents: timestamped transcripts, SRT subtitles, source maps, a manifest, and optional summaries / chapters. Use it for archives, subtitle export, timestamp-backed summaries, meeting notes, or clip ideas.

## What do translation and summaries need?

Download a Qwen3 model on first use: 4B (2.5 GB) for 8 GB RAM, 8B (5 GB) for 16 GB, 14B (9 GB) for 32 GB. Transcription alone runs fine on 8 GB without AI features.

## Mixed-language transcripts?

Not possible — each task locks a single language. If English recognition quality disappoints, download a Whisper model (large-v3-turbo recommended); auto mode then routes English audio to Whisper automatically.

## "Transcription is not ready"?

The model files are incomplete or were deleted. Re-download the model in Settings → Models.

## Windows support?

In development. Currently macOS Apple Silicon only.

## Open source? Free?

Apache-2.0 licensed, completely free — no paid features, no subscriptions.
