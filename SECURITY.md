# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report suspected vulnerabilities **privately** using GitHub's
private vulnerability reporting:

→ <https://github.com/twoer/subcast/security/advisories/new>

This keeps the report visible only to the maintainer and lets us
coordinate a fix before any public disclosure. Include as much of the
following as you can:

- A description of the issue and its impact.
- Minimal steps to reproduce (a crash log, a crafted file, a network
  trace — whatever is relevant).
- The Subcast version and OS you tested on.
- Whether you already have a fix in mind.

You should get an acknowledgment within a few days. If you don't hear
back, a polite nudge via the same private advisory channel is
appropriate.

## Scope

Subcast runs entirely on the user's own machine; there is no server
component under our control. In-scope issues include:

- Anything that lets a crafted media file escape the local processing
  pipeline (e.g. path traversal in upload/cache handling, command
  injection into the Whisper / ffmpeg / Ollama sidecars).
- Local privilege-escalation or unsafe handling of user data under the
  app's data directory.
- A regression in the redaction performed by
  `server/utils/logSanitize.ts` that leaks raw file paths, filenames,
  or transcript text into the exported diagnostics zip when debug mode
  is **off**.
- Electron main-process exposure (an exploitable IPC channel, an
  overly permissive `contextBridge` surface, a `nodeIntegration` /
  `contextIsolation` misconfiguration).

## Supported versions

Only the **latest release** receives security fixes. Subcast is
pre-1.0 and does not maintain backport branches. Please verify your
issue reproduces on the newest release from
<https://github.com/twoer/subcast/releases> before reporting.

## Privacy notes for reporters

By design Subcast collects **no** telemetry, crash reports, or remote
error reporting — diagnostics are exported by explicit user action only
(see the README's *Troubleshooting* section). You don't need to worry
that filing a report triggers any automatic upload from your machine.
