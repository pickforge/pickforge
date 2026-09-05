#!/usr/bin/env bash
# Enforce the documented macOS asset policy on one candidate binary.
#
# Policy for the 0.4 release train (docs/releases/SIGNING.md): the macOS asset
# is a single-architecture arm64 Mach-O, ad-hoc signed, and *not* notarized.
# Ad-hoc signing is not cosmetic — Apple silicon refuses to execute a Mach-O
# with a broken or missing signature, and `strip` invalidates one.
#
# Usage: macos-asset-policy.sh <asset> <facts-output>
set -euo pipefail

asset="${1:?usage: macos-asset-policy.sh <asset> <facts-output>}"
facts="${2:?usage: macos-asset-policy.sh <asset> <facts-output>}"

fail() { printf 'macOS asset policy failed: %s\n' "$*" >&2; exit 1; }

architectures="$(lipo -archs "${asset}")"
[ "${architectures}" = "arm64" ] || fail "expected an arm64-only asset, got \"${architectures}\""

signature="$(codesign -dvv "${asset}" 2>&1 || true)"
printf '%s' "${signature}" | grep -q 'Signature=adhoc' \
  || fail "expected an ad-hoc signature; codesign reported:\n${signature}"
codesign --verify --strict "${asset}" \
  || fail "the ad-hoc signature does not verify (a post-signing strip breaks this)"

# Not notarized is the documented state, so assert it rather than hope for it.
# When notarization ships, this check and docs/releases/SIGNING.md change together.
assessment="$(spctl --assess --type execute -vv "${asset}" 2>&1 || true)"
printf '%s' "${assessment}" | grep -q 'rejected' \
  || fail "asset is accepted by Gatekeeper; update docs/releases/SIGNING.md and this check"

{
  printf 'architectures: %s\n' "${architectures}"
  printf 'signature: ad-hoc (verified)\n'
  printf 'notarization: none (documented policy)\n'
  printf 'file: %s\n' "$(file -b "${asset}")"
  printf 'codesign:\n%s\n' "${signature}"
  printf 'spctl:\n%s\n' "${assessment}"
} > "${facts}"
cat "${facts}"
