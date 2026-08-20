---
name: subcast
description: Use when the user wants an agent to control an authorized local Subcast instance to import, transcribe, analyze, translate, or export local audio/video with timestamped, privacy-preserving evidence. Trigger for requests such as transcribe a recording, create a media pack, summarize a meeting, make clip suggestions, export subtitles, or inspect Subcast processing readiness.
---

# Subcast

Use Subcast as the local processing engine; return a concise, evidence-backed result rather than reproducing raw media content.

## Connection Gate

Use an authorized local connection only. Do not print, persist, or request a desktop session token in chat. If no agent profile exists, ask the user to open `Settings > AI Assistant` in the running Subcast desktop app and enable local access, then read the temporary local profile described in [control-surface.md](references/control-surface.md).

Read [control-surface.md](references/control-surface.md) before calling the API. It defines the current endpoints, MCP tools, expected event completion, and the connection boundary.

## Workflow

1. Select a recipe from [recipes.md](references/recipes.md).
2. When the `subcast` MCP server is configured, use its tools in order: import, status, start the indicated processing step, wait, then export. Otherwise use the HTTP endpoints below.
3. Import only a user-provided absolute local path.
4. Follow the returned `nextAction`; never claim completion before `phase` is `bundle_ready`.
5. Save a media pack only to a user-approved output location; see [media-pack.md](references/media-pack.md).
6. Base any final claims on timestamps and source IDs from the media pack. Do not fabricate clip candidates, owners, decisions, or deadlines.

## Safety Rules

- Keep local paths, original filenames, connection credentials, prompts, and raw model output out of the final response.
- Do not process a remote URL unless the user explicitly asked and the connected Subcast instance supports that source.
- Never report a polished deliverable while a status response says media, transcript, or required Insights are missing.
- Report a short hash prefix, recipe, readiness/blocker, and timestamped result. Read [failure-handling.md](references/failure-handling.md) for terminal errors.
