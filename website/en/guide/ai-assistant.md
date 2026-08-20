---
description: Enable local AI Assistant access in Subcast, configure MCP, and let Codex or other agents import, transcribe, analyze, and export evidence-backed media packs locally.
---

# AI Assistant

Subcast can expose a controlled local entry point for AI assistants. Once enabled, Codex, Claude Desktop, and other MCP clients can use Subcast locally: import media, read processing status, start transcription or AI Insights, and export timestamped evidence packs.

This entry point is off by default. You explicitly enable it after opening Subcast, and authorization expires when the app quits.

## 1. Enable local access

Open Subcast, go to Settings → AI Assistant, then click Enable local AI Assistant access.

Subcast writes a temporary access profile inside the local app-data directory. It is readable only by the current user. Do not paste desktop session tokens or access-profile contents into chat; supported agents should use MCP or the Subcast skill to read the authorized local profile.

## 2. Install the Codex skill

From the source repo, run:

```bash
pnpm skill:install
```

It installs the Subcast skill to `~/.codex/skills/subcast`. To intentionally replace an older install, run:

```bash
pnpm skill:install -- --force
```

Then ask Codex for tasks like:

```text
Use Subcast to transcribe /path/to/video.mp4
Use Subcast to export a media pack for this video
```

## 3. Configure MCP

For the packaged app, prefer the bundled MCP launcher:

```json
{
  "mcpServers": {
    "subcast": {
      "command": "/Applications/Subcast.app/Contents/Resources/subcast-mcp"
    }
  }
}
```

For source development, build the desktop entry first:

```bash
pnpm build:desktop:main
```

Then point your client at the source entry:

```json
{
  "mcpServers": {
    "subcast": {
      "command": "node",
      "args": ["/absolute/path/to/subcast/desktop-dist/subcastMcp.js"]
    }
  }
}
```

## 4. What's in a media pack

The basic archive pack exports:

- `manifest.json`: redacted run metadata;
- `transcript.md`: timestamped transcript;
- `subtitles.srt`: subtitles from the same cue source;
- `chapters.md`: cached AI Insights chapters when available, otherwise a missing-state note;
- `summary.md`: cached AI summary when available, otherwise a missing-state note;
- `sources.json`: cue-level evidence map;
- `deliverable.md`: a short handoff note for downstream agents.

For clip ideas or meeting notes, run matching-language AI Insights in Subcast first, then export the `creator-brief` or `meeting-notes` recipe.

## Safety boundary

- Import only absolute local paths explicitly provided by the user.
- Authorization is valid only for the current Subcast session.
- Agent responses expose hash prefixes, readiness, and next actions by default.
- Do not expose original paths, full hashes, desktop tokens, prompts, or raw model output in chat.
