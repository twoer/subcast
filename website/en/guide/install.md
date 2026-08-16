# Installation

## System requirements

| | Minimum | Recommended |
|---|---|---|
| OS | macOS 13+ (Apple Silicon) | macOS 14+ |
| RAM | 8 GB | 16 GB or more |
| Disk | 1 GB (app + bundled model) | 10 GB (incl. AI models) |

The installer bundles the SenseVoice transcription model (~250 MB) — **works out of the box, no download needed**. AI translation / summary models (Qwen3) download on first use.

## Download

Grab the latest `.dmg` from [GitHub Releases](https://github.com/twoer/subcast/releases/latest).

## Steps

1. Open the `.dmg`;
2. Drag Subcast into `Applications`;
3. If macOS reports the app as "damaged" on first launch (Gatekeeper blocking an unsigned app — it isn't actually damaged), run in Terminal:

```bash
xattr -cr /Applications/Subcast.app
```

Then launch it normally.

## Windows / Linux

A Windows build is in development. Currently macOS Apple Silicon only.
