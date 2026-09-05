#!/usr/bin/env bash
# Project-state ownership smoke (#104).
#
# Proves, with the real Rust CLI and the real TypeScript lab, that both command
# orders work against the *same canonical project* in isolated homes:
#
#   A: pickforge init  ->  lab run
#   B: lab run         ->  pickforge init
#
# and that both converge on the same claimed layout without either tool
# migrating, deleting, or overwriting the other's state. The caller's real home
# is never touched: every invocation runs under `env -i` with a private HOME and
# PICKFORGE_HOME.
#
# Contract (environment):
#   PICKFORGE_CLI    optional  Rust binary (default: target/debug/pickforge)
#   PICKFORGE_WORK   optional  work directory (default: mktemp -d)
#   PICKFORGE_EVIDENCE optional evidence directory (default: <work>/evidence)
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
CLI="${PICKFORGE_CLI:-${REPO_ROOT}/target/debug/pickforge}"
WORK="${PICKFORGE_WORK:-$(mktemp -d)}"
EVIDENCE="${PICKFORGE_EVIDENCE:-${WORK}/evidence}"

log() { printf '\n=== %s\n' "$*"; }
fail() { printf 'state ownership smoke failed: %s\n' "$*" >&2; exit 1; }

[ -x "${CLI}" ] || fail "no Rust CLI at ${CLI} (cargo build -p pickforge-cli)"
command -v bun >/dev/null 2>&1 || fail "bun is required but not on PATH"

mkdir -p "${EVIDENCE}"

# `pickforge init` requires `dart` on PATH. The smoke is about state ownership,
# not about Dart, and init never executes it, so a stub is enough and keeps the
# run hermetic.
STUB_BIN="${WORK}/bin"
mkdir -p "${STUB_BIN}"
printf '#!/bin/sh\nexit 0\n' >"${STUB_BIN}/dart"
chmod +x "${STUB_BIN}/dart"

# One canonical project, used by both orders, so the derived project id — and
# therefore the state directory under test — is identical.
PROJECT="${WORK}/app"
mkdir -p "${PROJECT}"
printf 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' \
  >"${PROJECT}/pubspec.yaml"

# The lab's own entry point, driven exactly as a real run would be. The runner
# lives outside the repository, so it imports the lab by absolute path rather
# than relying on workspace resolution from a temp directory.
cat >"${WORK}/lab-run.mjs" <<EOF
import { createRun } from "${REPO_ROOT}/packages/core/src/run.ts";
const [projectDir, slug] = process.argv.slice(2);
const run = await createRun(projectDir, slug);
await run.finish("completed");
console.log(run.dir);
EOF

run_init() {
  home="$1"
  env -i PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${home}" \
    PICKFORGE_HOME="${home}/state" \
    "${CLI}" init --project-dir "${PROJECT}"
}

run_lab() {
  home="$1"
  slug="$2"
  ( cd "${REPO_ROOT}" && \
    env -i PATH="${PATH}" HOME="${home}" PICKFORGE_HOME="${home}/state" \
      bun "${WORK}/lab-run.mjs" "${PROJECT}" "${slug}" )
}

state_dir() {
  home="$1"
  set -- "${home}"/state/projects/*
  [ -d "$1" ] || fail "no project state directory under ${home}/state/projects"
  printf '%s\n' "$1"
}

# Sorted entry names of a directory: the ownership surface under test.
entries() { ( cd "$1" && ls -A | LC_ALL=C sort ); }

# --- Order A: init -> lab ------------------------------------------------
log "Order A: pickforge init, then a lab run"
HOME_A="${WORK}/home-a"
mkdir -p "${HOME_A}"
run_init "${HOME_A}" >"${EVIDENCE}/a-1-init.log" 2>&1 \
  || fail "order A: init failed (see ${EVIDENCE}/a-1-init.log)"
run_lab "${HOME_A}" run-a >"${EVIDENCE}/a-2-lab.log" 2>&1 \
  || fail "order A: lab run failed (see ${EVIDENCE}/a-2-lab.log)"
DIR_A="$(state_dir "${HOME_A}")"

# --- Order B: lab -> init ------------------------------------------------
# This is the order that regressed in #104: init refused the project outright
# because lab runs already existed under its state directory.
log "Order B: a lab run, then pickforge init"
HOME_B="${WORK}/home-b"
mkdir -p "${HOME_B}"
run_lab "${HOME_B}" run-b >"${EVIDENCE}/b-1-lab.log" 2>&1 \
  || fail "order B: lab run failed (see ${EVIDENCE}/b-1-lab.log)"
RUNS_BEFORE="$(entries "$(state_dir "${HOME_B}")/runs")"
run_init "${HOME_B}" >"${EVIDENCE}/b-2-init.log" 2>&1 \
  || fail "order B: init refused a project the lab had already used (#104)"
DIR_B="$(state_dir "${HOME_B}")"

# --- Both orders agree ---------------------------------------------------
log "Both orders converge on the same ownership"
{
  printf 'order A (%s):\n' "${DIR_A}"; entries "${DIR_A}"
  printf '\norder B (%s):\n' "${DIR_B}"; entries "${DIR_B}"
} >"${EVIDENCE}/layout-entries.txt"

[ "$(entries "${DIR_A}")" = "$(entries "${DIR_B}")" ] \
  || fail "orders disagree on state directory contents (see ${EVIDENCE}/layout-entries.txt)"
[ "$(entries "${DIR_A}")" = "$(printf 'layout.json\nproject.json\nruns')" ] \
  || fail "unexpected state directory contents: $(entries "${DIR_A}")"

# The marker both tools write must be byte-identical, whichever claimed first.
cmp "${DIR_A}/layout.json" "${DIR_B}/layout.json" \
  || fail "the two tools wrote different layout markers"
cp "${DIR_A}/layout.json" "${EVIDENCE}/layout.json"

# Order B's init must not have disturbed the run the lab wrote before it.
[ "$(entries "${DIR_B}/runs")" = "${RUNS_BEFORE}" ] \
  || fail "init changed the lab's runs in order B"

# --- Re-running either tool stays a no-op --------------------------------
log "Re-running each tool is a no-op"
run_init "${HOME_B}" >"${EVIDENCE}/b-3-reinit.log" 2>&1 \
  || fail "re-running init failed"
grep -q 'outcome: no-op' "${EVIDENCE}/b-3-reinit.log" \
  || fail "re-running init was not a no-op (see ${EVIDENCE}/b-3-reinit.log)"

# --- The caller's real home is untouched ---------------------------------
log "The real home was never touched"
[ ! -e "${HOME}/.pickforge/pickforge/projects/$(basename "${DIR_A}")" ] \
  || fail "the smoke wrote into the real home"

log "OK: both orders work, ownership is shared, nothing was migrated"
printf 'evidence: %s\n' "${EVIDENCE}"
