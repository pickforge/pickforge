#!/usr/bin/env bash
# Project-state ownership smoke (#104).
#
# Proves, with the real Rust CLI and the real TypeScript lab, that both command
# orders work against the *same canonical project* in isolated homes:
#
#   A: pickforge init  ->  lab run  ->  pickforge evidence record
#   B: lab run         ->  pickforge init  ->  pickforge evidence record
#
# that a real cross-process race between the two binaries yields exactly one
# claim, and that both tools fail closed — writing nothing — on every layout
# they do not understand. The caller's real home is never touched: every
# invocation runs under `env -i` with a private HOME and PICKFORGE_HOME.
#
# Contract (environment):
#   PICKFORGE_CLI      optional  Rust binary (default: target/debug/pickforge)
#   PICKFORGE_WORK     optional  work directory (default: mktemp -d)
#   PICKFORGE_EVIDENCE optional  evidence directory (default: <work>/evidence)
#   PICKFORGE_RACES    optional  cross-process race rounds (default: 10)
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
CLI="${PICKFORGE_CLI:-${REPO_ROOT}/target/debug/pickforge}"
WORK="${PICKFORGE_WORK:-$(mktemp -d)}"
EVIDENCE="${PICKFORGE_EVIDENCE:-${WORK}/evidence}"
RACES="${PICKFORGE_RACES:-10}"

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

# One complete evidence document, so `evidence record` exercises the same
# shared `runs/` the lab writes.
cat >"${WORK}/evidence-input.json" <<'EOF'
{
  "schemaVersion": 3,
  "scenario": "Counter increments",
  "outcome": "passed",
  "before": { "summary": "Counter was zero." },
  "after": { "summary": "Counter is one." }
}
EOF

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

run_evidence() {
  home="$1"
  env -i PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${home}" \
    PICKFORGE_HOME="${home}/state" \
    "${CLI}" evidence record --project-dir "${PROJECT}" \
    --input "${WORK}/evidence-input.json"
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

# --- Order A: init -> lab -> evidence ------------------------------------
log "Order A: pickforge init, then a lab run, then evidence record"
HOME_A="${WORK}/home-a"
mkdir -p "${HOME_A}"
run_init "${HOME_A}" >"${EVIDENCE}/a-1-init.log" 2>&1 \
  || fail "order A: init failed (see ${EVIDENCE}/a-1-init.log)"
run_lab "${HOME_A}" run-a >"${EVIDENCE}/a-2-lab.log" 2>&1 \
  || fail "order A: lab run failed (see ${EVIDENCE}/a-2-lab.log)"
run_evidence "${HOME_A}" >"${EVIDENCE}/a-3-evidence.log" 2>&1 \
  || fail "order A: evidence record failed (see ${EVIDENCE}/a-3-evidence.log)"
DIR_A="$(state_dir "${HOME_A}")"

# --- Order B: lab -> init -> evidence ------------------------------------
# This is the order that regressed in #104: init refused the project outright
# because lab runs already existed under its state directory.
log "Order B: a lab run, then pickforge init, then evidence record"
HOME_B="${WORK}/home-b"
mkdir -p "${HOME_B}"
run_lab "${HOME_B}" run-b >"${EVIDENCE}/b-1-lab.log" 2>&1 \
  || fail "order B: lab run failed (see ${EVIDENCE}/b-1-lab.log)"
RUNS_BEFORE="$(entries "$(state_dir "${HOME_B}")/runs")"
LAB_RUN_ENTRIES="$(entries "$(state_dir "${HOME_B}")/runs/${RUNS_BEFORE}")"
run_init "${HOME_B}" >"${EVIDENCE}/b-2-init.log" 2>&1 \
  || fail "order B: init refused a project the lab had already used (#104)"
run_evidence "${HOME_B}" >"${EVIDENCE}/b-3-evidence.log" 2>&1 \
  || fail "order B: evidence record failed (see ${EVIDENCE}/b-3-evidence.log)"
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

# The marker both tools write must be byte-identical, whichever claimed first,
# and must be a regular file with exactly one name.
cmp "${DIR_A}/layout.json" "${DIR_B}/layout.json" \
  || fail "the two tools wrote different layout markers"
[ ! -L "${DIR_A}/layout.json" ] || fail "the marker in order A is a symlink"
[ "$(stat -c '%h %F' "${DIR_A}/layout.json")" = "1 regular file" ] \
  || fail "the marker in order A is not a singly linked regular file"
cp "${DIR_A}/layout.json" "${EVIDENCE}/layout.json"

# The shared run tree holds both writers' runs, each in its own directory.
for dir in "${DIR_A}" "${DIR_B}"; do
  [ "$(entries "${dir}/runs" | wc -l)" -eq 2 ] \
    || fail "expected one lab run and one evidence run in ${dir}/runs"
done

# Order B's init must not have disturbed the run the lab wrote before it: the
# run is still there, with the same entries inside it.
entries "${DIR_B}/runs" | grep -Fxq "${RUNS_BEFORE}" \
  || fail "init removed or renamed the lab's run in order B"
[ "$(entries "${DIR_B}/runs/${RUNS_BEFORE}")" = "${LAB_RUN_ENTRIES}" ] \
  || fail "init changed the contents of the lab's run in order B"

# --- Re-running either tool stays a no-op --------------------------------
log "Re-running each tool is a no-op"
run_init "${HOME_B}" >"${EVIDENCE}/b-4-reinit.log" 2>&1 \
  || fail "re-running init failed"
grep -q 'outcome: no-op' "${EVIDENCE}/b-4-reinit.log" \
  || fail "re-running init was not a no-op (see ${EVIDENCE}/b-4-reinit.log)"

# --- Concurrent first use, in two real processes -------------------------
# The Rust CLI and the TypeScript lab reach one fresh project state directory
# at the same time, repeatedly. Exactly one of them may create the marker, both
# must succeed, and the marker must always carry complete bytes.
log "Cross-process race: pickforge init against a lab run (${RACES} rounds)"
for round in $(seq 1 "${RACES}"); do
  HOME_R="${WORK}/home-race-${round}"
  mkdir -p "${HOME_R}"
  # Pay the lab's startup cost before the race, so both tools reach the
  # directory in the same window rather than one always arriving first.
  ( run_lab "${HOME_R}" "race-${round}" >"${EVIDENCE}/race-${round}-lab.log" 2>&1 \
      || echo "lab failed" >"${WORK}/race-lab-failed" ) &
  lab_pid=$!
  ( run_init "${HOME_R}" >"${EVIDENCE}/race-${round}-init.log" 2>&1 \
      || echo "init failed" >"${WORK}/race-init-failed" ) &
  init_pid=$!
  wait "${lab_pid}" || true
  wait "${init_pid}" || true
  [ ! -f "${WORK}/race-lab-failed" ] \
    || fail "round ${round}: the lab failed (see ${EVIDENCE}/race-${round}-lab.log)"
  [ ! -f "${WORK}/race-init-failed" ] \
    || fail "round ${round}: init failed (see ${EVIDENCE}/race-${round}-init.log)"
  DIR_R="$(state_dir "${HOME_R}")"
  cmp "${DIR_R}/layout.json" "${EVIDENCE}/layout.json" \
    || fail "round ${round}: the marker is not the complete shared marker"
  [ "$(stat -c '%h' "${DIR_R}/layout.json")" = "1" ] \
    || fail "round ${round}: the marker has more than one name"
  [ "$(entries "${DIR_R}")" = "$(printf 'layout.json\nproject.json\nruns')" ] \
    || fail "round ${round}: unexpected contents $(entries "${DIR_R}")"
done

# --- Negative controls: both tools must fail closed ----------------------
# Each case plants one adversarial layout in a fresh home and requires *both*
# binaries to refuse it, write nothing, and leave the planted state exactly as
# it was.
plant_home() {
  name="$1"
  home="${WORK}/home-${name}"
  # The project id is derived from the canonical project path, so it is the
  # same directory name the working orders above produced.
  dir="${home}/state/projects/$(basename "${DIR_A}")"
  mkdir -p "${dir}"
  printf '%s\n' "${dir}"
}

refuses_both() {
  name="$1"
  home="${WORK}/home-${name}"
  if run_init "${home}" >"${EVIDENCE}/${name}-init.log" 2>&1; then
    fail "${name}: pickforge init did not fail closed"
  fi
  if run_lab "${home}" "${name}" >"${EVIDENCE}/${name}-lab.log" 2>&1; then
    fail "${name}: the lab did not fail closed"
  fi
}

log "Negative control: an unsupported layout version"
DIR="$(plant_home unsupported)"
printf '{"layout":"pickforge-project-state","layoutVersion":99}\n' \
  >"${DIR}/layout.json"
refuses_both unsupported
[ "$(entries "${DIR}")" = "layout.json" ] \
  || fail "unsupported: something was written beside the marker"
grep -q 'layout version 99' "${EVIDENCE}/unsupported-init.log" \
  || fail "unsupported: init did not name the version"

log "Negative control: a stray layout.json"
DIR="$(plant_home stray)"
printf '{"layout":"something-else"}\n' >"${DIR}/layout.json"
refuses_both stray
[ "$(entries "${DIR}")" = "layout.json" ] \
  || fail "stray: something was written beside the marker"

log "Negative control: a symlinked marker pointing at valid bytes"
DIR="$(plant_home symlinked)"
cp "${EVIDENCE}/layout.json" "${WORK}/outside-marker.json"
ln -s "${WORK}/outside-marker.json" "${DIR}/layout.json"
refuses_both symlinked
[ -L "${DIR}/layout.json" ] || fail "symlinked: the planted link was replaced"
cmp "${WORK}/outside-marker.json" "${EVIDENCE}/layout.json" \
  || fail "symlinked: the link's target was written through"
[ "$(entries "${DIR}")" = "layout.json" ] \
  || fail "symlinked: something was written beside the marker"

log "Negative control: a foreign entry in an unclaimed directory"
DIR="$(plant_home foreign)"
printf 'not ours\n' >"${DIR}/notes.txt"
refuses_both foreign
[ "$(entries "${DIR}")" = "notes.txt" ] \
  || fail "foreign: something was written beside the unowned entry"
grep -q "mv -n --" "${EVIDENCE}/foreign-init.log" \
  || fail "foreign: init did not offer a no-clobber, quoted command"

log "Negative control: evidence recording under an unsupported layout"
# The review's repro: `evidence record` writes into the shared `runs/`, so a
# layout it does not understand must stop it exactly as it stops `init`.
HOME_E="${WORK}/home-evidence"
mkdir -p "${HOME_E}"
run_init "${HOME_E}" >"${EVIDENCE}/evidence-control-init.log" 2>&1 \
  || fail "evidence control: init failed"
DIR="$(state_dir "${HOME_E}")"
printf '{"layout":"pickforge-project-state","layoutVersion":99}\n' \
  >"${DIR}/layout.json"
if run_evidence "${HOME_E}" >"${EVIDENCE}/evidence-control.log" 2>&1; then
  fail "evidence control: evidence record did not fail closed"
fi
grep -q 'layout version 99' "${EVIDENCE}/evidence-control.log" \
  || fail "evidence control: the refusal did not name the version"
[ ! -e "${DIR}/runs" ] || fail "evidence control: a run was written anyway"

log "Negative control: a planted staging name pointing outside the directory"
# The pre-fix CLI derived its staging name from the pid and thread id and
# opened it with `create(true).truncate(true)`, so this link was followed: the
# marker bytes replaced the external file and `layout.json` became a symlink.
DIR="$(plant_home planted)"
printf 'private\n' >"${WORK}/planted-target"
ln -s "${WORK}/planted-target" "${DIR}/.pickforge-tmp-layout-1-ThreadId(1)"
if run_init "${WORK}/home-planted" >"${EVIDENCE}/planted-init.log" 2>&1; then
  fail "planted: init did not refuse a symlinked entry in its state directory"
fi
[ "$(cat "${WORK}/planted-target")" = "private" ] \
  || fail "planted: the external file was written through"
[ ! -e "${DIR}/layout.json" ] || fail "planted: a marker was written anyway"
[ -L "${DIR}/.pickforge-tmp-layout-1-ThreadId(1)" ] \
  || fail "planted: init removed an entry it did not create"

log "Control: a stale staging file with the name a crashed run would leave"
# A crash remnant plus pid reuse must not divert this run's staging entry, and
# must not be deleted: the claim stages under an unpredictable name of its own.
DIR="$(plant_home stale)"
printf 'crash remnant\n' >"${DIR}/.pickforge-tmp-layout-1-ThreadId(1)"
run_init "${WORK}/home-stale" >"${EVIDENCE}/stale-init.log" 2>&1 \
  || fail "stale: init failed on an inert transient"
[ "$(cat "${DIR}/.pickforge-tmp-layout-1-ThreadId(1)")" = "crash remnant" ] \
  || fail "stale: init wrote through or removed a crash remnant"
[ ! -L "${DIR}/layout.json" ] || fail "stale: the marker is a symlink"
cmp "${DIR}/layout.json" "${EVIDENCE}/layout.json" \
  || fail "stale: the marker is not the shared marker"

# --- The caller's real home is untouched ---------------------------------
log "The real home was never touched"
[ ! -e "${HOME}/.pickforge/pickforge/projects/$(basename "${DIR_A}")" ] \
  || fail "the smoke wrote into the real home"

log "OK: both orders and both writers work, races yield one claim, unknown layouts fail closed"
printf 'evidence: %s\n' "${EVIDENCE}"
