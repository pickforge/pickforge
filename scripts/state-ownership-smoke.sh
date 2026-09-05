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

# Every invocation is bounded. A refusal that never returns is not a refusal:
# the marker checks below open entries a blocking `open(2)` would never come
# back from (a FIFO, a socket, a device), so a hang has to be distinguishable
# from a clean non-zero exit. `timeout` reports 124 for one, and the controls
# check for it explicitly.
STEP_TIMEOUT="${PICKFORGE_STEP_TIMEOUT:-120}"
TIMED_OUT=124

run_init() {
  home="$1"
  timeout "${STEP_TIMEOUT}" \
    env -i PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${home}" \
    PICKFORGE_HOME="${home}/state" \
    "${CLI}" init --project-dir "${PROJECT}"
}

run_init_dry_run() {
  home="$1"
  timeout "${STEP_TIMEOUT}" \
    env -i PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${home}" \
    PICKFORGE_HOME="${home}/state" \
    "${CLI}" init --project-dir "${PROJECT}" --dry-run
}

run_evidence() {
  home="$1"
  timeout "${STEP_TIMEOUT}" \
    env -i PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${home}" \
    PICKFORGE_HOME="${home}/state" \
    "${CLI}" evidence record --project-dir "${PROJECT}" \
    --input "${WORK}/evidence-input.json"
}

run_lab() {
  home="$1"
  slug="$2"
  ( cd "${REPO_ROOT}" && \
    timeout "${STEP_TIMEOUT}" \
      env -i PATH="${PATH}" HOME="${home}" PICKFORGE_HOME="${home}/state" \
      bun "${WORK}/lab-run.mjs" "${PROJECT}" "${slug}" )
}

# Permission bits of a path, for the private-mode checks.
mode_of() { stat -c '%a' "$1"; }

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

# Both binaries must refuse, and must refuse *promptly*: an invocation killed
# by the timeout is a hang, not a refusal, and is reported as its own failure.
refuses_both() {
  name="$1"
  home="${WORK}/home-${name}"
  status=0
  run_init "${home}" >"${EVIDENCE}/${name}-init.log" 2>&1 || status=$?
  [ "${status}" -ne 0 ] || fail "${name}: pickforge init did not fail closed"
  [ "${status}" -ne "${TIMED_OUT}" ] \
    || fail "${name}: pickforge init blocked instead of refusing"
  status=0
  run_lab "${home}" "${name}" >"${EVIDENCE}/${name}-lab.log" 2>&1 || status=$?
  [ "${status}" -ne 0 ] || fail "${name}: the lab did not fail closed"
  [ "${status}" -ne "${TIMED_OUT}" ] \
    || fail "${name}: the lab blocked instead of refusing"
}

# The dry run must preview exactly the refusal the real run performs, and write
# nothing while doing it.
refuses_dry_run() {
  name="$1"
  home="${WORK}/home-${name}"
  status=0
  run_init_dry_run "${home}" >"${EVIDENCE}/${name}-dry-run.log" 2>&1 || status=$?
  [ "${status}" -ne 0 ] || fail "${name}: init --dry-run reported a clean plan"
  [ "${status}" -ne "${TIMED_OUT}" ] \
    || fail "${name}: init --dry-run blocked instead of refusing"
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

log "Negative control: a FIFO planted as the marker"
# A blocking `open(2)` on a FIFO never returns: before the marker open became
# non-blocking, both tools hung here forever instead of refusing (#104 R1).
DIR="$(plant_home fifo)"
mkfifo -- "${DIR}/layout.json"
refuses_both fifo
refuses_dry_run fifo
grep -q 'named pipe' "${EVIDENCE}/fifo-init.log" \
  || fail "fifo: init did not name what the entry actually is"
grep -q 'named pipe' "${EVIDENCE}/fifo-lab.log" \
  || fail "fifo: the lab did not name what the entry actually is"
[ -p "${DIR}/layout.json" ] || fail "fifo: the planted FIFO was replaced"
[ "$(entries "${DIR}")" = "layout.json" ] \
  || fail "fifo: something was written beside the FIFO"

log "Negative control: a socket planted as the marker"
DIR="$(plant_home socket)"
python3 -c 'import socket,sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])' "${DIR}/layout.json"
refuses_both socket
[ -S "${DIR}/layout.json" ] || fail "socket: the planted socket was replaced"
[ "$(entries "${DIR}")" = "layout.json" ] \
  || fail "socket: something was written beside the socket"

log "Negative control: a symlinked run tree in an unclaimed directory"
# Both tools refuse to write through a symlinked `runs`, so neither may stamp
# the marker that tells the other the layout is sound (#104 R7).
DIR="$(plant_home linkedruns)"
mkdir -p "${WORK}/outside-runs"
ln -s "${WORK}/outside-runs" "${DIR}/runs"
refuses_both linkedruns
refuses_dry_run linkedruns
grep -q 'runs is not a directory' "${EVIDENCE}/linkedruns-init.log" \
  || fail "linkedruns: init did not name the run tree"
grep -q 'runs is not a directory' "${EVIDENCE}/linkedruns-lab.log" \
  || fail "linkedruns: the lab did not name the run tree"
[ ! -e "${DIR}/layout.json" ] || fail "linkedruns: a marker was stamped anyway"
[ -z "$(ls -A "${WORK}/outside-runs")" ] \
  || fail "linkedruns: something was written through the link"

log "Negative control: a symlinked projects/<id> state directory"
# The lab has always refused this; the Rust CLI used to follow it, because the
# transaction layer canonicalised the path first (#104 R3).
HOME_L="${WORK}/home-linkeddir"
mkdir -p "${HOME_L}/state/projects" "${WORK}/outside-state"
ln -s "${WORK}/outside-state" "${HOME_L}/state/projects/$(basename "${DIR_A}")"
refuses_both linkeddir
refuses_dry_run linkeddir
for log_file in linkeddir-init linkeddir-lab; do
  grep -qi 'symbolic link\|symlink' "${EVIDENCE}/${log_file}.log" \
    || fail "linkeddir: ${log_file} did not name the symlink"
done
[ -z "$(ls -A "${WORK}/outside-state")" ] \
  || fail "linkeddir: something was written through the link"
# `evidence record` refuses it too, on the same logical path.
if run_evidence "${HOME_L}" >"${EVIDENCE}/linkeddir-evidence.log" 2>&1; then
  fail "linkeddir: evidence record did not fail closed"
fi

log "Negative control: an entry whose name is not valid UTF-8"
# Neither tool may print a copyable command for a name it cannot render: the
# path in the command would not address the file on disk (#104 R5).
DIR="$(plant_home badname)"
printf 'x\n' >"$(printf '%b' "${DIR}/bad-\xff-name")"
refuses_both badname
for log_file in badname-init badname-lab; do
  grep -q 'not valid UTF-8' "${EVIDENCE}/${log_file}.log" \
    || fail "badname: ${log_file} did not name the problem"
  grep -q 'Move it aside yourself' "${EVIDENCE}/${log_file}.log" \
    || fail "badname: ${log_file} did not describe the entry"
  ! grep -q 'mv -n' "${EVIDENCE}/${log_file}.log" \
    || fail "badname: ${log_file} offered a command for a name it cannot render"
done
[ ! -e "${DIR}/layout.json" ] || fail "badname: a marker was stamped anyway"

log "Negative control: init --dry-run previews the refusal it will perform"
# With a receipt present and no marker, the dry run used to report a clean plan
# for a directory the real run then refused (#104 R2).
HOME_D="${WORK}/home-dryrun"
mkdir -p "${HOME_D}"
run_init "${HOME_D}" >"${EVIDENCE}/dryrun-init.log" 2>&1 \
  || fail "dry run control: init failed"
DIR="$(state_dir "${HOME_D}")"
rm -f "${DIR}/layout.json"
printf 'not ours\n' >"${DIR}/notes.txt"
refuses_dry_run dryrun
grep -q 'notes.txt is not owned by Pickforge' "${EVIDENCE}/dryrun-dry-run.log" \
  || fail "dry run control: the preview did not name the unowned entry"
grep -q 'mv -n --' "${EVIDENCE}/dryrun-dry-run.log" \
  || fail "dry run control: the preview did not offer the manual action"
[ ! -e "${DIR}/layout.json" ] || fail "dry run control: the preview wrote a marker"
# ... and the real run refuses exactly the same thing.
if run_init "${HOME_D}" >"${EVIDENCE}/dryrun-apply.log" 2>&1; then
  fail "dry run control: the real run did not refuse what the preview refused"
fi
grep -q 'notes.txt is not owned by Pickforge' "${EVIDENCE}/dryrun-apply.log" \
  || fail "dry run control: preview and apply disagree"

# --- Both tools create private directories -------------------------------
log "Both tools create the shared state tree owner-only (0700)"
# Whichever tool gets there first, the state root, `projects/`, the project
# directory, and `runs/` are private; the marker and the receipt are 0600/0644
# as their writers create them (#104 R4).
for home in "${HOME_A}" "${HOME_B}"; do
  dir="$(state_dir "${home}")"
  for target in "${home}/state" "${home}/state/projects" "${dir}" "${dir}/runs"; do
    [ "$(mode_of "${target}")" = "700" ] \
      || fail "mode: ${target} is $(mode_of "${target}"), expected 700"
  done
  [ "$(mode_of "${dir}/layout.json")" = "600" ] \
    || fail "mode: the marker is $(mode_of "${dir}/layout.json"), expected 600"
done

# --- More cross-language races -------------------------------------------
# The race above is init against a first lab run. These two cover the other
# real orders: both tools writing runs into a directory one of them already
# claimed, and three writers reaching one fresh directory at once.
log "Cross-process race: evidence record against a lab run in a claimed directory (${RACES} rounds)"
for round in $(seq 1 "${RACES}"); do
  HOME_S="${WORK}/home-shared-${round}"
  mkdir -p "${HOME_S}"
  run_init "${HOME_S}" >"${EVIDENCE}/shared-${round}-init.log" 2>&1 \
    || fail "shared round ${round}: init failed"
  rm -f "${WORK}/shared-lab-failed" "${WORK}/shared-evidence-failed"
  ( run_lab "${HOME_S}" "shared-${round}" \
      >"${EVIDENCE}/shared-${round}-lab.log" 2>&1 \
      || echo failed >"${WORK}/shared-lab-failed" ) &
  lab_pid=$!
  ( run_evidence "${HOME_S}" >"${EVIDENCE}/shared-${round}-evidence.log" 2>&1 \
      || echo failed >"${WORK}/shared-evidence-failed" ) &
  evidence_pid=$!
  wait "${lab_pid}" || true
  wait "${evidence_pid}" || true
  [ ! -f "${WORK}/shared-lab-failed" ] \
    || fail "shared round ${round}: the lab failed (see ${EVIDENCE}/shared-${round}-lab.log)"
  [ ! -f "${WORK}/shared-evidence-failed" ] \
    || fail "shared round ${round}: evidence record failed (see ${EVIDENCE}/shared-${round}-evidence.log)"
  DIR_S="$(state_dir "${HOME_S}")"
  [ "$(entries "${DIR_S}/runs" | wc -l)" -eq 2 ] \
    || fail "shared round ${round}: expected one lab run and one evidence run"
  [ "$(stat -c '%h' "${DIR_S}/layout.json")" = "1" ] \
    || fail "shared round ${round}: the marker has more than one name"
done

log "Cross-process race: init, a lab run, and evidence record on one fresh directory (${RACES} rounds)"
# `evidence record` needs a receipt, so it can only join once init has written
# one; it is started immediately after init and races the lab's claim.
for round in $(seq 1 "${RACES}"); do
  HOME_T="${WORK}/home-three-${round}"
  mkdir -p "${HOME_T}"
  rm -f "${WORK}/three-lab-failed" "${WORK}/three-init-failed"
  ( run_lab "${HOME_T}" "three-${round}" \
      >"${EVIDENCE}/three-${round}-lab.log" 2>&1 \
      || echo failed >"${WORK}/three-lab-failed" ) &
  lab_pid=$!
  ( run_init "${HOME_T}" >"${EVIDENCE}/three-${round}-init.log" 2>&1 \
      && run_evidence "${HOME_T}" >"${EVIDENCE}/three-${round}-evidence.log" 2>&1 \
      || echo failed >"${WORK}/three-init-failed" ) &
  init_pid=$!
  wait "${lab_pid}" || true
  wait "${init_pid}" || true
  [ ! -f "${WORK}/three-lab-failed" ] \
    || fail "three-way round ${round}: the lab failed"
  [ ! -f "${WORK}/three-init-failed" ] \
    || fail "three-way round ${round}: init or evidence record failed"
  DIR_T="$(state_dir "${HOME_T}")"
  cmp "${DIR_T}/layout.json" "${EVIDENCE}/layout.json" \
    || fail "three-way round ${round}: the marker is not the complete shared marker"
  [ "$(entries "${DIR_T}")" = "$(printf 'layout.json\nproject.json\nruns')" ] \
    || fail "three-way round ${round}: unexpected contents $(entries "${DIR_T}")"
  [ "$(entries "${DIR_T}/runs" | wc -l)" -eq 2 ] \
    || fail "three-way round ${round}: expected one lab run and one evidence run"
done

# --- The caller's real home is untouched ---------------------------------
log "The real home was never touched"
[ ! -e "${HOME}/.pickforge/pickforge/projects/$(basename "${DIR_A}")" ] \
  || fail "the smoke wrote into the real home"

log "OK: both orders and both writers work, races yield one claim, unknown layouts fail closed"
printf 'evidence: %s\n' "${EVIDENCE}"
