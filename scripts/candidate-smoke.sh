#!/usr/bin/env bash
# Candidate artifact smoke.
#
# Installs and exercises *only* release candidate artifacts (the packed npm
# tarball and the built Rust asset) in an isolated home against a real Flutter
# project. Nothing here builds from the source tree, and nothing here touches
# the caller's real home or the project tree.
#
# Contract (environment):
#   PICKFORGE_SMOKE_VERSION       required  expected version, e.g. 0.4.0-alpha.2
#   PICKFORGE_SMOKE_ASSET_DIR     required  directory holding the Rust asset and its .sha256
#   PICKFORGE_SMOKE_ASSET         optional  exact asset name (default: derived from uname)
#   PICKFORGE_SMOKE_TARBALL       optional  npm candidate tarball; installs the lab too
#   PICKFORGE_SMOKE_TARBALL_SHA256 optional checksum file for it (default: <tarball>.sha256)
#   PICKFORGE_SMOKE_EXPECT_ARCH   optional  required `uname -m` value
#   PICKFORGE_SMOKE_WORK          optional  work directory (default: mktemp -d)
#   PICKFORGE_SMOKE_EVIDENCE      optional  evidence directory (default: <work>/evidence)
#   PICKFORGE_SMOKE_INSTALL_SH    optional  installer path (default: alongside this script)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
SMOKE_HELPERS="${SCRIPT_DIR}/smoke"
# Keep uploaded logs small enough to read: every captured stream is truncated.
MAX_LOG_BYTES=262144
# Planted in the evidence document to prove the recorder redacts secrets.
SMOKE_SECRET="ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII"
# Exact Pickforge and harness targets that must never change in the caller's
# real home. Keep this bounded: populated harness and state roots can contain
# hundreds of thousands of unrelated files.
REAL_HOME_CONFIG_PATHS=".claude.json .codex/config.toml .config/mcp/mcp.json .claude/skills/pickforge-flutter/SKILL.md .agents/skills/pickforge-flutter/SKILL.md"

log() { printf '\n=== %s\n' "$*"; }
fail() { printf 'candidate smoke failed: %s\n' "$*" >&2; exit 1; }

require_env() {
  eval "value=\${$1:-}"
  [ -n "${value}" ] || fail "$1 is required"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not on PATH"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# A sorted "<relative path> <sha256|dir|-> " listing used to prove that a tree
# did not change. Symlinks are recorded by target, never followed.
snapshot() {
  root="$1"
  [ -d "${root}" ] || { printf 'missing %s\n' "${root}"; return 0; }
  ( cd "${root}" && find . -mindepth 1 | LC_ALL=C sort | while IFS= read -r entry; do
      if [ -L "${entry}" ]; then
        printf '%s symlink %s\n' "${entry}" "$(readlink "${entry}")"
      elif [ -d "${entry}" ]; then
        printf '%s dir\n' "${entry}"
      else
        printf '%s %s\n' "${entry}" "$(sha256_file "${entry}")"
      fi
    done )
}

assert_unchanged() {
  label="$1"; before="$2"; after="$3"
  if ! diff -u "${before}" "${after}" > "${EVIDENCE}/${label}.diff"; then
    head -c "${MAX_LOG_BYTES}" "${EVIDENCE}/${label}.diff" >&2
    fail "${label} changed"
  fi
  rm -f "${EVIDENCE}/${label}.diff"
}

capture() {
  name="$1"; shift
  status=0
  "$@" > "${EVIDENCE}/${name}.out" 2> "${EVIDENCE}/${name}.err" || status=$?
  for stream in out err; do
    file="${EVIDENCE}/${name}.${stream}"
    if [ "$(wc -c < "${file}")" -gt "${MAX_LOG_BYTES}" ]; then
      head -c "${MAX_LOG_BYTES}" "${file}" > "${file}.trimmed"
      printf '\n[truncated at %s bytes]\n' "${MAX_LOG_BYTES}" >> "${file}.trimmed"
      mv "${file}.trimmed" "${file}"
    fi
  done
  return "${status}"
}

# Every Pickforge invocation runs against the isolated home and state root.
pickforge_run() {
  env HOME="${SMOKE_HOME}" USERPROFILE="${SMOKE_HOME}" \
    XDG_CONFIG_HOME="${SMOKE_HOME}/.config" XDG_DATA_HOME="${SMOKE_HOME}/.local/share" \
    PICKFORGE_HOME="${STATE}" "$@"
}

resolve_asset_name() {
  [ -n "${PICKFORGE_SMOKE_ASSET:-}" ] && { ASSET="${PICKFORGE_SMOKE_ASSET}"; return; }
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64|Linux:amd64) ASSET="pickforge-linux-x86_64" ;;
    Darwin:arm64|Darwin:aarch64) ASSET="pickforge-macos-arm64" ;;
    *) fail "no Pickforge Rust asset for $(uname -s) $(uname -m)" ;;
  esac
}

record_facts() {
  log "environment facts"
  {
    printf 'date: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'uname: %s %s\n' "$(uname -s)" "$(uname -m)"
    printf 'expected version: %s\n' "${PICKFORGE_SMOKE_VERSION}"
    printf 'asset: %s\n' "${ASSET}"
    printf 'npm tarball: %s\n' "${PICKFORGE_SMOKE_TARBALL:-<none>}"
    printf 'flutter: %s\n' "$(flutter --version 2>&1 | head -n 1)"
    printf 'dart: %s\n' "$(dart --version 2>&1 | head -n 1)"
    printf 'node: %s\n' "$(node --version 2>&1)"
  } | tee "${EVIDENCE}/facts.txt"

  if [ -n "${PICKFORGE_SMOKE_EXPECT_ARCH:-}" ]; then
    [ "$(uname -m)" = "${PICKFORGE_SMOKE_EXPECT_ARCH}" ] \
      || fail "expected ${PICKFORGE_SMOKE_EXPECT_ARCH} runner, got $(uname -m)"
  fi
}

verify_asset() {
  log "verify candidate asset ${ASSET}"
  asset_path="${PICKFORGE_SMOKE_ASSET_DIR}/${ASSET}"
  [ -f "${asset_path}" ] || fail "candidate asset is missing: ${asset_path}"
  [ -f "${asset_path}.sha256" ] || fail "candidate checksum is missing: ${asset_path}.sha256"
  expected="$(awk 'NR==1{print $1}' "${asset_path}.sha256" | tr 'A-F' 'a-f')"
  actual="$(sha256_file "${asset_path}")"
  [ "${expected}" = "${actual}" ] || fail "asset checksum mismatch: ${actual} != ${expected}"
  printf 'asset sha256: %s\n' "${actual}" | tee -a "${EVIDENCE}/facts.txt"
}

# The npm tarball crosses an artifact upload/download before it gets here, and
# publish only checks it much later. Verify it where it is actually installed,
# so the bytes this smoke exercises are provably the packed candidate.
verify_tarball() {
  log "verify candidate npm tarball"
  tarball="${PICKFORGE_SMOKE_TARBALL}"
  [ -f "${tarball}" ] || fail "candidate tarball is missing: ${tarball}"
  checksum="${PICKFORGE_SMOKE_TARBALL_SHA256:-${tarball}.sha256}"
  [ -f "${checksum}" ] || fail "candidate tarball checksum is missing: ${checksum}"
  TARBALL_SHA256="$(awk 'NR==1{print $1}' "${checksum}" | tr 'A-F' 'a-f')"
  case "${TARBALL_SHA256}" in
    *[!0-9a-f]*|"") fail "candidate tarball checksum is not a SHA-256 value: ${checksum}" ;;
  esac
  [ "${#TARBALL_SHA256}" -eq 64 ] \
    || fail "candidate tarball checksum is not a SHA-256 value: ${checksum}"
  actual="$(sha256_file "${tarball}")"
  [ "${TARBALL_SHA256}" = "${actual}" ] \
    || fail "npm tarball checksum mismatch: ${actual} != ${TARBALL_SHA256}"
  printf 'npm tarball sha256: %s\n' "${actual}" | tee -a "${EVIDENCE}/facts.txt"
}

# The installer is given a path, not a copy. Re-hashing afterwards proves the
# install consumed the verified bytes and left them alone.
assert_tarball_unchanged() {
  actual="$(sha256_file "${PICKFORGE_SMOKE_TARBALL}")"
  [ "${TARBALL_SHA256}" = "${actual}" ] \
    || fail "the npm tarball changed during install: ${actual} != ${TARBALL_SHA256}"
}

install_from_tarball() {
  log "install candidate npm tarball and Rust asset through the public installer"
  [ -f "${INSTALL_SH}" ] || fail "installer not found: ${INSTALL_SH}"
  env HOME="${SMOKE_HOME}" \
    npm_config_prefix="${PREFIX}" \
    PATH="${PREFIX}/bin:${PATH}" \
    PICKFORGE_INSTALL_RUNTIME=npm \
    PICKFORGE_INSTALL_FROM_TARBALL="${PICKFORGE_SMOKE_TARBALL}" \
    PICKFORGE_INSTALL_RELEASE_BASE_URL="file://${PICKFORGE_SMOKE_ASSET_DIR}" \
    sh "${INSTALL_SH}" 2>&1 | tee "${EVIDENCE}/install.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || fail "installer failed"
}

install_asset_only() {
  log "install the candidate Rust asset only (the TypeScript lab is Linux-only)"
  mkdir -p "${PREFIX}/bin"
  cp "${PICKFORGE_SMOKE_ASSET_DIR}/${ASSET}" "${PREFIX}/bin/pickforge"
  chmod 0755 "${PREFIX}/bin/pickforge"
}

assert_versions() {
  log "assert candidate versions"
  expected="${PICKFORGE_SMOKE_VERSION}"
  actual="$("${PREFIX}/bin/pickforge" --version)"
  [ "${actual}" = "pickforge ${expected}" ] \
    || fail "pickforge reported \"${actual}\", expected \"pickforge ${expected}\""
  printf 'pickforge: %s\n' "${actual}" | tee -a "${EVIDENCE}/facts.txt"
  [ -n "${PICKFORGE_SMOKE_TARBALL:-}" ] || return 0
  actual="$("${PREFIX}/bin/pickforge-lab" --version)"
  [ "${actual}" = "${expected}" ] \
    || fail "pickforge-lab reported \"${actual}\", expected \"${expected}\""
  printf 'pickforge-lab: %s\n' "${actual}" | tee -a "${EVIDENCE}/facts.txt"
  # pickforge-mcp is a stdio server with no --version flag, so its version comes
  # from a real MCP handshake with the installed binary.
  [ -x "${PREFIX}/bin/pickforge-mcp" ] || fail "pickforge-mcp was not installed"
  env HOME="${SMOKE_HOME}" PICKFORGE_HOME="${STATE}" \
    node "${SMOKE_HELPERS}/mcp-handshake.mjs" \
      --command "${PREFIX}/bin/pickforge-mcp" \
      --project "${WORK}" \
      --expect-version "${expected}" \
      --out "${EVIDENCE}/mcp-lab-handshake.json" \
      > "${EVIDENCE}/mcp-lab-handshake.log" 2>&1 \
    || { head -c "${MAX_LOG_BYTES}" "${EVIDENCE}/mcp-lab-handshake.log" >&2; fail "pickforge-mcp handshake failed"; }
  printf 'pickforge-mcp: %s (MCP serverInfo)\n' "${expected}" | tee -a "${EVIDENCE}/facts.txt"
}

create_project() {
  log "create a disposable Flutter project"
  # The isolated home moves the pub cache, so keep the real cache for fixture
  # creation only. The candidate binaries under test never see it.
  env HOME="${SMOKE_HOME}" PUB_CACHE="${PUB_CACHE:-${REAL_HOME}/.pub-cache}" \
    flutter create --platforms="${PLATFORM}" --project-name pickforge_candidate_smoke \
    "${PROJECT}" > "${EVIDENCE}/flutter-create.log" 2>&1 \
    || { head -c "${MAX_LOG_BYTES}" "${EVIDENCE}/flutter-create.log" >&2; fail "flutter create failed"; }
  [ -f "${PROJECT}/pubspec.yaml" ] || fail "flutter create produced no pubspec.yaml"
  snapshot "${PROJECT}" > "${WORK}/project-before.txt"
}

run_doctor() {
  log "doctor against the candidate binary"
  status=0
  capture doctor pickforge_run "${PREFIX}/bin/pickforge" doctor --json --project-dir "${PROJECT}" || status=$?
  node "${SMOKE_HELPERS}/smoke-checks.mjs" doctor "${EVIDENCE}/doctor.out" \
    --state "${STATE}" --project "${PROJECT}" --exit-status "${status}"
  capture doctor-text pickforge_run "${PREFIX}/bin/pickforge" doctor --project-dir "${PROJECT}" || true
}

run_init_dry_run() {
  log "init --dry-run writes nothing"
  snapshot "${SMOKE_HOME}" > "${WORK}/home-before-dry-run.txt"
  snapshot "${STATE}" > "${WORK}/state-before-dry-run.txt"
  capture init-dry-run pickforge_run "${PREFIX}/bin/pickforge" init --json --dry-run \
    --project-dir "${PROJECT}" "${HARNESS_ARGS[@]}" || fail "init --dry-run failed"
  node "${SMOKE_HELPERS}/smoke-checks.mjs" init-plan "${EVIDENCE}/init-dry-run.out" --home "${SMOKE_HOME}"
  snapshot "${SMOKE_HOME}" > "${WORK}/home-after-dry-run.txt"
  snapshot "${STATE}" > "${WORK}/state-after-dry-run.txt"
  assert_unchanged home-during-dry-run "${WORK}/home-before-dry-run.txt" "${WORK}/home-after-dry-run.txt"
  assert_unchanged state-during-dry-run "${WORK}/state-before-dry-run.txt" "${WORK}/state-after-dry-run.txt"
}

run_init_apply() {
  log "init applies the Flutter integration"
  capture init-apply pickforge_run "${PREFIX}/bin/pickforge" init --json \
    --project-dir "${PROJECT}" "${HARNESS_ARGS[@]}" || fail "init failed"
  node "${SMOKE_HELPERS}/smoke-checks.mjs" init-apply "${EVIDENCE}/init-apply.out" --home "${SMOKE_HOME}"
}

run_mcp_handshake() {
  log "real Dart MCP handshake through the generated configuration"
  env HOME="${SMOKE_HOME}" USERPROFILE="${SMOKE_HOME}" \
    XDG_CONFIG_HOME="${SMOKE_HOME}/.config" XDG_DATA_HOME="${SMOKE_HOME}/.local/share" \
    PICKFORGE_HOME="${STATE}" \
    node "${SMOKE_HELPERS}/mcp-handshake.mjs" \
      --config "${SMOKE_HOME}/.claude.json" \
      --server pickforge-dart \
      --project "${PROJECT}" \
      --out "${EVIDENCE}/mcp-handshake.json" \
      > "${EVIDENCE}/mcp-handshake.log" 2>&1 \
    || { head -c "${MAX_LOG_BYTES}" "${EVIDENCE}/mcp-handshake.log" >&2; fail "Dart MCP handshake failed"; }
  head -c "${MAX_LOG_BYTES}" "${EVIDENCE}/mcp-handshake.json"
}

run_init_idempotency() {
  log "init is idempotent"
  # Snapshotted here, not after the first apply: the Dart MCP server writes its
  # own telemetry into the isolated home, and that is not an init change.
  snapshot "${SMOKE_HOME}" > "${WORK}/home-before-repeat.txt"
  capture init-repeat pickforge_run "${PREFIX}/bin/pickforge" init --json \
    --project-dir "${PROJECT}" "${HARNESS_ARGS[@]}" || fail "second init failed"
  node "${SMOKE_HELPERS}/smoke-checks.mjs" init-repeat "${EVIDENCE}/init-repeat.out" --home "${SMOKE_HOME}"
  snapshot "${SMOKE_HOME}" > "${WORK}/home-after-repeat.txt"
  assert_unchanged home-during-repeat "${WORK}/home-before-repeat.txt" "${WORK}/home-after-repeat.txt"
}

run_evidence() {
  log "record evidence into the isolated state root"
  node "${SMOKE_HELPERS}/smoke-checks.mjs" evidence-input "${WORK}/evidence-input.json" \
    --artifact "${WORK}/before.png" --secret "${SMOKE_SECRET}"
  status=0
  pickforge_run "${PREFIX}/bin/pickforge" evidence record --json --project-dir "${PROJECT}" \
    --input "${WORK}/evidence-input.json" > "${EVIDENCE}/evidence-record.out" 2>&1 || status=$?
  [ "${status}" -eq 0 ] || { head -c "${MAX_LOG_BYTES}" "${EVIDENCE}/evidence-record.out" >&2; fail "evidence record failed"; }
  node "${SMOKE_HELPERS}/smoke-checks.mjs" evidence-result "${EVIDENCE}/evidence-record.out" \
    --state "${STATE}" --project "${PROJECT}" --secret "${SMOKE_SECRET}"
}

assert_clean_project() {
  log "the project tree contains only the Flutter files it started with"
  snapshot "${PROJECT}" > "${WORK}/project-after.txt"
  assert_unchanged project-tree "${WORK}/project-before.txt" "${WORK}/project-after.txt"
  for polluted in .pickforge .picklab .pickforge.json pickforge.json; do
    if [ -e "${PROJECT}/${polluted}" ]; then
      fail "project tree was polluted with ${polluted}"
    fi
  done
  cp "${WORK}/project-after.txt" "${EVIDENCE}/project-tree.txt"
}

# The only real-home state directories either binary could derive for this
# disposable project. The project path is unique, so these must start absent;
# that lets the smoke detect a leak without hashing every existing run in the
# user's state roots.
set_real_home_paths() {
  project_id="$(node -e '
    const crypto = require("node:crypto");
    const path = require("node:path");
    const project = path.resolve(process.argv[1]);
    const slug = (path.basename(project).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project").slice(0, 40);
    const hash = crypto.createHash("sha256").update(project).digest("hex").slice(0, 16);
    process.stdout.write(slug + "-" + hash);
  ' "${PROJECT}")"
  REAL_HOME_PROJECT_PATHS=".pickforge/pickforge/projects/${project_id} .pickforge/lab/projects/${project_id} .picklab/projects/${project_id}"
}

assert_real_home_project_paths_absent() {
  for relative in ${REAL_HOME_PROJECT_PATHS}; do
    [ ! -e "${REAL_HOME}/${relative}" ] && [ ! -L "${REAL_HOME}/${relative}" ] \
      || fail "real-home project path already exists; use a fresh smoke work directory: ${REAL_HOME}/${relative}"
  done
}

# Records only exact config, skill, and project-state targets. This is bounded
# regardless of how much unrelated state exists in the caller's home.
capture_real_home() {
  target="$1"
  : > "${target}"
  for relative in ${REAL_HOME_CONFIG_PATHS} ${REAL_HOME_PROJECT_PATHS}; do
    path="${REAL_HOME}/${relative}"
    if [ -L "${path}" ]; then
      printf '%s symlink %s\n' "${relative}" "$(readlink "${path}")" >> "${target}"
    elif [ -f "${path}" ]; then
      printf '%s file %s\n' "${relative}" "$(sha256_file "${path}")" >> "${target}"
    elif [ -d "${path}" ]; then
      printf '%s dir\n' "${relative}" >> "${target}"
    elif [ -e "${path}" ]; then
      printf '%s other\n' "${relative}" >> "${target}"
    else
      printf '%s absent\n' "${relative}" >> "${target}"
    fi
  done
}

assert_clean_real_home() {
  log "the real home has no Pickforge or harness writes"
  capture_real_home "${WORK}/real-home-after.txt"
  assert_unchanged real-home "${WORK}/real-home-before.txt" "${WORK}/real-home-after.txt"
  cp "${WORK}/real-home-after.txt" "${EVIDENCE}/real-home.txt"
}

summarize() {
  {
    printf '# Candidate artifact smoke\n\n'
    cat "${EVIDENCE}/facts.txt"
    printf '\nchecks: artifact checksums, versions, flutter detection, doctor, init dry-run isolation, '
    printf 'init apply, Dart MCP handshake, init idempotency, evidence recording, '
    printf 'clean project tree, clean real home\n'
  } > "${EVIDENCE}/summary.md"
  log "candidate artifact smoke passed"
  cat "${EVIDENCE}/summary.md"
}

main() {
  require_env PICKFORGE_SMOKE_VERSION
  require_env PICKFORGE_SMOKE_ASSET_DIR
  for tool in node flutter dart find diff; do require_tool "${tool}"; done

  resolve_asset_name
  REAL_HOME="${HOME:?HOME must be set}"
  WORK="${PICKFORGE_SMOKE_WORK:-$(mktemp -d)}"
  mkdir -p "${WORK}"
  # Canonical: on macOS `mktemp -d` hands back /var/... for /private/var/...,
  # and the CLI reports canonical paths, so uncanonicalized bases would make
  # every "inside the isolated home" check compare two different spellings.
  WORK="$(cd -- "${WORK}" && pwd -P)"
  EVIDENCE="${PICKFORGE_SMOKE_EVIDENCE:-${WORK}/evidence}"
  INSTALL_SH="${PICKFORGE_SMOKE_INSTALL_SH:-${SCRIPT_DIR}/install.sh}"
  SMOKE_HOME="${WORK}/home"
  STATE="${WORK}/state"
  PROJECT="${WORK}/project"
  PREFIX="${WORK}/prefix"
  HARNESS_ARGS=(--harness claude-code --harness codex --harness pi)
  case "$(uname -s)" in Darwin) PLATFORM=macos ;; *) PLATFORM=linux ;; esac
  mkdir -p "${EVIDENCE}" "${SMOKE_HOME}" "${PREFIX}/bin"
  set_real_home_paths
  assert_real_home_project_paths_absent

  record_facts
  verify_asset
  capture_real_home "${WORK}/real-home-before.txt"
  if [ -n "${PICKFORGE_SMOKE_TARBALL:-}" ]; then
    verify_tarball
    install_from_tarball
    assert_tarball_unchanged
  else
    install_asset_only
  fi
  assert_versions
  create_project
  run_doctor
  run_init_dry_run
  run_init_apply
  run_mcp_handshake
  run_init_idempotency
  run_evidence
  assert_clean_project
  assert_clean_real_home
  summarize
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
