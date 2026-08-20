# Control Surface

The Subcast desktop server binds to `127.0.0.1` and requires an authorized agent connection. The ordinary Electron session token is deliberately private and must not be exposed to an agent or copied from application memory.

For the packaged desktop app, the user explicitly enables local access through `Settings > AI Assistant`. It creates a temporary `agent-access.json` profile inside the Subcast app-data home, normally `~/Library/Application Support/Subcast/agent-access.json` on macOS. Read the profile only after the user has enabled access; use its `baseUrl` and `token` as `x-subcast-agent-token`. The profile is owner-readable only and disappears when Subcast quits. Never include its location or contents in chat output, bundle contents, or logs.

All request and response bodies below are JSON unless the endpoint is an SSE stream or ZIP response.

## MCP (preferred client integration)

The `subcast` MCP server composes this authorized local API without exposing the profile contents to the model. Once installed and configured, model clients can call:

- `subcast_import_media`
- `subcast_get_media_status`
- `subcast_start_transcription`
- `subcast_start_insights`
- `subcast_wait_for_media`
- `subcast_export_media_pack`

The import tool accepts a user-approved absolute source path, but returns only redacted media metadata. The export tool requires an explicit absolute output path and refuses replacement unless `overwrite: true`. Tool results never include a local path, original filename, or access token.

## Import

`POST /api/agent/import`

```json
{ "path": "/absolute/path/to/media.mp4", "recipe": "generic-archive-pack", "language": "en" }
```

The response returns `hash`, `hashPrefix`, and a redacted `media` status. Do not echo the input path or filename after the call.

## Readiness

`GET /api/agent/media/:hash?recipe=<recipe>&language=<zh-CN|en>`

Follow `nextAction` exactly:

- `start_transcribe`: open `GET /api/transcribe?hash=<full hash>` as SSE.
- `wait_for_transcribe`: wait briefly, then poll readiness again.
- `start_insights`: open `GET /api/insights?hash=<full hash>` as SSE and send `Accept-Language: zh-CN` or `en`.
- `wait_for_insights`: wait briefly, then poll readiness again.
- `export_bundle`: call agent export.

Treat the SSE `done` event as completion. Treat `error` as terminal for that attempt and use the readiness response to report its redacted error code.

## Export

`POST /api/agent/export`

```json
{ "hash": "full-or-unambiguous-prefix", "recipe": "creator-brief", "language": "en" }
```

The endpoint returns a ZIP media pack. Save it only to a user-approved output location. Do not infer a local file path from the response or place it in a repository documentation directory.

All recipes return a ZIP media pack. `creator-brief` and `meeting-notes` return `409 MEDIA_NOT_READY` until matching-language Insights are complete.
