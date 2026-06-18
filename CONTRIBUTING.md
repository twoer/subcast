# Contributing to Subcast

Thanks for considering a contribution! Subcast is an offline,
privacy-first transcription / translation desktop app, and every
contribution — bug reports, fixes, docs, translations — is welcome.

This guide covers how to report issues, set up a dev environment, and
land a change. The companion [`AGENTS.md`](./AGENTS.md) holds the
authoritative rules on module boundaries and packaging; when the two
disagree, AGENTS.md wins.

---

## Reporting bugs and requesting features

- **Bugs** — open an issue using the *Bug report* template. Attach a
  diagnostics zip (**Help → Export Diagnostics…** in the app, or the
  tray menu) so we can see the last 7 days of structured logs. No video
  content or transcript text is included.
- **Features** — open an issue using the *Feature request* template.
  Describe the use case, not just the solution.
- **Security** — see [`SECURITY.md`](./SECURITY.md). **Do not** open a
  public issue for security vulnerabilities.

The issue tracker lives at
<https://github.com/twoer/subcast/issues>.

---

## Development setup

Requirements: **Node 22** and **pnpm 9**.

```bash
git clone https://github.com/twoer/subcast.git
cd subcast
pnpm install
pnpm dev          # http://localhost:3000 — plain Nuxt, no Electron
```

Dev mode runs as a regular Nuxt 4 web server; no Electron, no
`userData`. For the desktop (Electron) dev/build flow, see the
[Developers section of the README](./README.md#developers--run-from-source).

### Useful commands

```bash
pnpm test:run     # vitest --run (runs ensure-sqlite-abi first)
pnpm typecheck    # nuxt typecheck
pnpm lint         # eslint .
pnpm dev:desktop  # Electron dev mode (hot)
```

Targeted tests are faster while iterating:

```bash
pnpm vitest --run app/composables/__tests__/useBatchStaging.test.ts
```

---

## Code structure (at a glance)

| Directory   | Responsibility                                            |
|-------------|-----------------------------------------------------------|
| `app/`      | Nuxt/Vue pages, components, composables, UI utilities.    |
| `server/`   | Nitro API routes, queue, transcription, translation, logs.|
| `desktop/`  | Electron main/preload, menus, updater, model management.  |
| `shared/`   | Runtime-neutral TypeScript utilities and constants.       |

The module boundaries (what may import what) are spelled out in
[AGENTS.md → Module Boundaries](./AGENTS.md#module-boundaries). The
short version:

- `app/` may import `app/`, `shared/`, Nuxt aliases, browser-safe deps.
- `app/` **must not** import `desktop/` or Node/Electron modules.
- `shared/` must stay runtime-neutral (no fs, no Electron, no side
  effects).

A quick boundary check:

```bash
rg -n "desktop/modelManager|\.\./\.\./desktop" app   # expect no matches
```

---

## Translations

Subcast ships in five locales and translation is one of the easiest ways
to contribute — no build tooling to learn, just JSON.

### Locale files

All locale files live in `i18n/locales/`:

| File         | Locale | Name       |
|--------------|--------|------------|
| `en.json`    | `en`   | English (default) |
| `zh-CN.json` | `zh`   | 简体中文    |
| `zh-TW.json` | `zh-TW`| 繁體中文    |
| `ja.json`    | `ja`   | 日本語      |
| `es.json`    | `es`   | Español     |

Keys are **nested**, grouped into 12 top-level namespaces:
`app`, `fileStatus`, `library`, `index`, `health`, `companion`,
`player`, `batch`, `common`, `settings`, `help`, `desktop`. Keep new
keys under the matching namespace rather than at the root.

### Adding a new language

1. Register it in `nuxt.config.ts` → `i18n.locales`:
   ```ts
   { code: 'fr', file: 'fr.json', name: 'Français' }
   ```
2. Copy `i18n/locales/en.json` to `i18n/locales/fr.json` and translate
   the values (the JSON structure / key set must stay identical).
3. Run `pnpm dev`, switch to the new language in the app's language
   dropdown, and walk through the main screens to verify.

Open a PR with both the new locale file and the `nuxt.config.ts` change.

### Keeping locales in sync

There's **no** automated key-completeness check yet — building one is a
great first issue (see [good first issues →
#1](#1-i18n-key-completeness)). Until it exists, please keep every
locale's key tree identical to `en.json` so no string falls back to its
key in production.

---

## Landing a change

### Branch and commit style

- Branch from `main`. Name branches descriptively
  (`add-ja-translations`, `fix-waveform-seek`, not `patch-1`).
- Use [Conventional Commits](https://www.conventionalcommits.org/) style
  prefixes — the existing history uses `feat:`, `fix:`, `refactor:`,
  `docs:`, `ci:`, `chore:`. Keep the subject line under ~72 chars.
- One logical change per commit. A refactoring and a behavior fix
  belong in separate commits even if they touch the same file.

### Before opening a PR

All three must pass — please run them locally before opening a PR:

```bash
pnpm lint
pnpm typecheck
pnpm test:run
```

### Pull request checklist

A PR template will remind you, but in short:

- [ ] Tests pass, type check passes, lint passes.
- [ ] New behavior is covered by a test where practical.
- [ ] One PR = one logical change.
- [ ] If you touched packaging/sidecar behavior, you read
      [AGENTS.md → Desktop Packaging Rules](./AGENTS.md#desktop-packaging-rules).
- [ ] The PR description explains *why*, not just *what*.

### License

Subcast is [Apache-2.0](./LICENSE). Contributions are accepted
under the same license — by submitting a PR you agree your changes are
released under Apache-2.0.

---

## Good first issues

Tasks that are small, self-contained, and don't touch the fragile
desktop-packaging path — ideal for a first contribution. Pick one,
leave a comment to claim it, and open a PR.

> These are *candidates* from a scan of the codebase. The actual
> `good first issue` labels live on GitHub issues — if a candidate
> below has no matching issue yet, open one and we'll label it.

1. **i18n key completeness.** The locale files under `i18n/locales/`
   (`en`, `zh-CN`, `zh-TW`, `ja`, `es`) should define the same key set.
   Write a small script (or a Vitest case) that diffs the key trees and
   reports missing keys per locale; then fill the gaps.
2. **Keyboard-shortcut docs vs. code.** The shortcut table in the README
   should match the bindings in `app/composables/usePlayerKeybindings.ts`.
   Add a Vitest case that asserts the README's key set equals the
   handler's key set, so the docs can't drift.
3. **Utility-function test coverage.** Several small pure helpers in
   `app/utils/` and `shared/` (e.g. `format.ts`, `fileStatus.ts`,
   `shared/chunking.ts`) have little or no direct test coverage. Pick one
   and add focused Vitest cases.
4. **Link-checking for docs.** Add a CI job or a Vitest case that
   greps `docs/**/*.md` and `README*.md` for `http(s)://` links and
   flags any that 404. (Skip GitHub-internal anchors.)
5. **Diagnostics redaction tests.** `server/utils/logSanitize.ts`
   already has tests; audit it for a path/filename shape that slips
   through un-redacted and add a regression case.
6. **Locale string QA.** Read through a non-English locale (e.g. `ja`
   or `es`) and flag any untranslated English fragments, awkward
   machine-translation, or strings that overflow the known UI
   containers. File as issues or fix in place.

When in doubt about whether something is in scope, open a draft PR or
an issue and ask before investing time — we'd rather save you the
detour.
