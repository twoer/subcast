# Windows code-signing (self-signed) — runbook

> Phase 1.14 / decision 24. macOS-only laptops can't run any of the steps
> below — keep this doc as the source of truth and execute on the Windows
> test box (or have a teammate run it once and hand off the `.pfx`).

## Goal

Produce a 5-year self-signed code-signing certificate, register it with
Windows, export to a password-protected `.pfx`, and feed it into
electron-builder's `cscLink` / `cscKeyPassword` so `pnpm build:desktop:win`
emits a signed `.exe` installer.

Self-signed buys us **two** things on Win 11:

1. The SmartScreen warning shows the publisher name ("Subcast (twoer)")
   instead of the scary "Unknown publisher".
2. The `.exe` Properties → Digital Signatures tab shows a signature, which
   plenty of corporate AV tools require before they'll even let a user
   double-click.

It does **not** make SmartScreen disappear on first run — only an OV/EV
certificate from a CA does that. See risk row in
`docs/desktop-execution-plan.md` Appendix C.

## Prereqs

- Windows 11 (24H2 OK)
- PowerShell 7+ run as the user that will build (no admin needed for
  CurrentUser cert store; admin needed for LocalMachine)
- The repo cloned, `pnpm install` already run

## Step 1 — Generate the certificate (one-time, ~10 seconds)

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=Subcast (twoer)" `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(5) `
  -KeyUsage DigitalSignature `
  -FriendlyName "Subcast Code Signing"

Write-Host "Thumbprint: $($cert.Thumbprint)"
```

Save the thumbprint somewhere — you'll need it to find the cert later.

## Step 2 — Export to `.pfx`

Pick a passphrase you can stash in a password manager. **Don't** commit it.

```powershell
$pwd = Read-Host -AsSecureString -Prompt "PFX passphrase"
Export-PfxCertificate `
  -Cert $cert `
  -FilePath subcast-codesign.pfx `
  -Password $pwd
```

Result: `subcast-codesign.pfx` in the current directory. Treat it like a
private key — encrypt at rest, never push to git.

## Step 3 — Wire into electron-builder

electron-builder 26.x reads two env vars:

- `WIN_CSC_LINK` — path to the `.pfx` *or* a base64-encoded blob
- `WIN_CSC_KEY_PASSWORD` — passphrase from Step 2

For local builds, point at the file directly:

```powershell
$env:WIN_CSC_LINK = "C:\path\to\subcast-codesign.pfx"
$env:WIN_CSC_KEY_PASSWORD = "your-passphrase"
pnpm build:desktop:win
```

Verify: in `dist-electron\` right-click the `.exe` → **Properties** →
**Digital Signatures** tab → "Subcast (twoer)" appears.

## Step 4 — CI wiring (GitHub Actions)

In repo settings → Secrets → Actions, add:

| Secret name             | Value                                         |
|-------------------------|-----------------------------------------------|
| `WIN_CSC_LINK`          | base64 of the `.pfx` file (see snippet below) |
| `WIN_CSC_KEY_PASSWORD`  | passphrase                                    |

Encode locally:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("subcast-codesign.pfx")) `
  | Set-Clipboard
```

Paste into the `WIN_CSC_LINK` secret. electron-builder auto-detects the
base64 form vs. a file path and handles both.

In the release workflow (not yet committed — Phase 5):

```yaml
- name: Build Windows
  env:
    WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
    WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
  run: pnpm build:desktop:win
```

## Renewal

`NotAfter` is set to 5 years. Calendar a reminder a month before that.
Renewal = re-run Step 1 with a fresh `New-SelfSignedCertificate` and
re-export. The new cert breaks differential auto-updates (electron-updater
compares cert thumbprints), so plan a full-installer release alongside.

## Upgrade path → OV cert

If SmartScreen warnings become a deal-breaker for users:

- DigiCert / Sectigo / SSL.com OV code-signing cert ≈ $200/year
- Issuance now requires a hardware token (Yubico FIPS or equivalent) per
  CA/B Forum baseline — no more plain `.pfx` files
- electron-builder supports cloud HSM signers via `azureSignOptions` (one
  of several `signtoolOptions` variants), but YubiHSM PKCS#11 needs a
  custom signing hook

When that day comes, swap `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` for the
HSM-backed flow and leave this doc as historical reference.
