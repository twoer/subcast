# Subcast release runbook (Phase 5.5)

Step-by-step recipe for cutting a `v0.x.y` release. Designed to be
copy-pasted into a release issue and ticked off line by line.

> **Pre-flight (once per major version)** — § 0 below. Skip if v0.1.0
> already shipped.

---

## 0. Pre-flight (first release only)

- [ ] GitHub repository secrets configured:
  - `WIN_CSC_LINK` (base64-encoded `.pfx`) per
    [`docs/windows-codesigning.md`](./windows-codesigning.md)
  - `WIN_CSC_KEY_PASSWORD` (passphrase for the same `.pfx`)
- [ ] `.github/workflows/build-whisper.yml` has run **at least once**;
      both `whisper-cli-macos-14-arm64` and `whisper-cli-windows-latest-x64`
      artifacts exist and haven't expired
- [ ] Local sanity:
  - [ ] `pnpm test` — 82 passing
  - [ ] `pnpm typecheck` — 0 errors
  - [ ] `pnpm lint` — 0 errors
  - [ ] `pnpm build:desktop:mac` produces a `.dmg` locally (network
        timeouts on electron headers excepted)

---

## 1. Smoke-test the candidate (Phase 5.3)

Build a release-candidate locally and run through
[`docs/smoke-tests.md`](./smoke-tests.md) on whichever platform you can
reach. Note any deviations in the release notes.

- [ ] macOS arm64 happy path
- [ ] Windows x64 happy path (or note "deferred to user reports")
- [ ] Special scenarios (decisions 22 / 34 / 35)

---

## 2. Record performance baseline (Phase 5.4)

- [ ] Measure cold launch, RSS, first-cue, etc., per
      [`docs/performance-baseline.md`](./performance-baseline.md)
- [ ] Append a dated block under "Measurements"
- [ ] Commit the file

---

## 3. Tag

- [ ] Update `package.json` `version` to `0.x.y` (no `v` prefix)
- [ ] `pnpm install` to refresh `pnpm-lock.yaml`
- [ ] Commit `chore(release): v0.x.y`
- [ ] `git tag v0.x.y -m "Subcast v0.x.y"`
- [ ] `git push && git push --tags`

The tag push triggers `.github/workflows/release.yml` — watch it on
the Actions tab. Expected duration: ~12 min macOS + ~10 min Windows
running in parallel.

---

## 4. Draft release notes

The workflow uploads artifacts to a **draft** release. Open it and fill
in the body — a template:

```markdown
## Subcast v0.x.y

> Free · Offline · LLM-powered — audio/video transcription + translation.

### Highlights
- … (1–3 bullets of user-visible changes)

### Installation
- **macOS (Apple Silicon)**: download the `.dmg`; right-click → Open
  (macOS 14) or System Settings → Privacy & Security → Open Anyway
  (macOS 15+). Full instructions in the [README](https://github.com/twoer/subcast#readme).
- **Windows (x64)**: download the `.exe`; SmartScreen will prompt —
  click *More info → Run anyway*.

### What's changed
- … (auto-generated from `git log v0.(x-1)..HEAD --oneline`)

### Known limitations
- macOS auto-update is manual (Help → Check for Updates…). Decision 9.
- Windows SmartScreen prompts on first run; self-signed cert. Decision 9.

### Checksums
The workflow uploads SHA512 in `latest.yml` / `latest-mac.yml`; users
shouldn't need to verify by hand, but the data is there.

### License
[AGPL-3.0-or-later](https://github.com/twoer/subcast/blob/main/LICENSE)
```

- [ ] Auto-generated changelog block dropped in
- [ ] Manual highlight bullets written
- [ ] Screenshots (or note "no UX changes") attached
- [ ] All draft assets present:
  - `Subcast-<v>-arm64.dmg`
  - `Subcast-<v>-arm64.dmg.blockmap`
  - `latest-mac.yml`
  - `Subcast-Setup-<v>.exe`
  - `Subcast-Setup-<v>.exe.blockmap`
  - `latest.yml`

---

## 5. Publish

- [ ] Press **Publish release** on GitHub
- [ ] Confirm `electron-updater` `latest.yml` URLs resolve:
      `curl -I https://github.com/twoer/subcast/releases/latest/download/latest.yml`
- [ ] Confirm the macOS manual-update flow surfaces the new tag —
      launch the previous version, wait ~5 s, expect the "Update
      available" dialog

---

## 6. README + announcement

- [ ] Add / refresh the Download badge at the top of README.md once
      the first release lands; for subsequent releases the badge auto-
      tracks the latest tag (shields.io)
- [ ] Update screenshots if any UI moved
- [ ] (Optional) Tweet / Hacker News / Show HN

---

## 7. Post-mortem (next-day)

Quick retro entry in the release issue:

- What broke between local build and CI?
- Which smoke-test items regressed?
- Any user-reported install failures in the first 24 h?
- Action items for the next release runbook

---

## Rollback

If a release goes out broken:

- [ ] **Unpublish** the GitHub Release (turn it back into a draft) so
      the install + auto-update URLs 404 cleanly
- [ ] Tag a `v0.x.(y+1)` fix asap; do **not** retag the broken version
      — electron-updater compares versions, and re-tagging is a sin
- [ ] Mention the rollback in the next release notes
