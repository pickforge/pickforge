#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/pickforge-gitleaks.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
log_opts="${1:-HEAD --diff-merges=first-parent}"

fail() { printf 'gitleaks merge check failed: %s\n' "$*" >&2; exit 1; }

# Ignore host Git settings and hooks in this throwaway repository.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git init -q --template= --initial-branch=main "$work/repo"
cd "$work/repo"
git config user.name 'Gitleaks fixture'
git config user.email 'gitleaks-fixture@example.invalid'
cp "$root/.gitleaks.toml" .
printf 'base\n' > resolution.txt
git add .
git commit -qm base
git checkout -qb side
printf 'side\n' > resolution.txt
git commit -qam side
git checkout -q main
printf 'main\n' > resolution.txt
git commit -qam main
if git merge --no-commit side >"$work/merge.log" 2>&1; then
  fail 'expected a conflicting merge'
fi
[[ "$(git diff --name-only --diff-filter=U)" == resolution.txt ]] \
  || fail 'merge did not conflict in resolution.txt'

# Generate an obviously fake GitHub PAT. Never store the complete token in source.
printf 'ghp_%s%s\n' 'FAKE' '0123456789abcdefghijklmnopqrstuv' > resolution.txt
git add resolution.txt
git commit -qm 'resolve conflict with synthetic token'
merge_commit="$(git rev-parse HEAD)"
[[ "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3 ]] \
  || fail 'fixture is not a two-parent merge'

scan() {
  local opts="$1" report="$2" status=0
  docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 \
    git --redact --no-banner --log-opts="$opts" \
    --report-format=json --report-path="/repo/$report" /repo \
    >"$work/scan.log" 2>&1 || status=$?
  [[ "$status" -eq 0 || "$status" -eq 1 ]] \
    || fail "scanner failed with exit $status"
  [[ -f "$report" ]] || fail 'scanner did not write a report'
  scan_status="$status"
}

# The old command must miss the token, proving it exists only in the resolution.
scan HEAD baseline.json
[[ "$scan_status" -eq 0 ]] && jq -e 'length == 0' baseline.json >/dev/null \
  || fail 'baseline unexpectedly reported a finding'
printf 'PASS: plain HEAD misses the merge-only token\n'

scan "$log_opts" merge.json
[[ "$scan_status" -eq 1 ]] && jq -e --arg commit "$merge_commit" '
  length == 1 and .[0].Commit == $commit
  and .[0].File == "resolution.txt" and .[0].RuleID == "github-pat"
  and .[0].Secret == "REDACTED"
' merge.json >/dev/null || fail 'merge-only token was not reported and redacted'
printf 'PASS: %s reports the token in the merge commit\n' "$log_opts"
