# Signing and notarization policy

This is the honest, current state, not an aspiration. The release workflow
enforces it: `scripts/smoke/macos-asset-policy.sh` fails the macOS candidate
smoke if reality drifts from this document in either direction.

## macOS (`pickforge-macos-arm64`)

- **Ad-hoc signed, not notarized, no Developer ID.** The linker's ad-hoc
  signature is re-applied after `strip`, because stripping invalidates it and
  Apple silicon refuses to execute an arm64 Mach-O whose signature is broken.
  The gate verifies the signature with `codesign --verify --strict` and then
  executes the asset, so a broken-signature build cannot ship again.
- **Integrity comes from the published SHA-256 file and npm provenance**, not
  from Apple. `scripts/install.sh` verifies the checksum before installing.
- **What users see.** A binary installed with the installer (`curl` or `wget`)
  carries no quarantine attribute and runs. A binary downloaded with a browser
  is quarantined, and Gatekeeper blocks the first run. The documented remedy is
  `xattr -d com.apple.quarantine ./pickforge-macos-arm64`, after verifying the
  checksum.
- **Why not sign yet.** Developer ID signing and notarization need a paid Apple
  Developer account, a distributable certificate, and secrets in CI. That is a
  deliberate cost decision for the 0.4 train, not an oversight.

## Decision for 0.4.0

Ship unsigned and un-notarized for the whole 0.4 train, with checksums, npm
provenance, and this document. Revisit before any release that advertises macOS
as a first-class installed product rather than a verified CLI download.

Changing the policy means changing three things in the same PR: this file, the
assertions in `scripts/smoke/macos-asset-policy.sh`, and the signing steps in
`.github/workflows/candidate-artifacts.yml`.

## Linux (`pickforge-linux-x86_64`)

No signing scheme applies. Integrity comes from the SHA-256 file published next
to the asset and from the checksum verification in `scripts/install.sh`.

## npm (`pickforge`)

Published from GitHub Actions through npm trusted publishing (OIDC) with
`--provenance`. The publish job uploads the exact tarball the candidate smokes
installed; its SHA-256 is verified in the publish job before upload.
