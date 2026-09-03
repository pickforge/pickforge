#!/bin/sh
# PickLab installer: curl -fsSL https://pickforge.dev/pickforge-lab/install.sh | sh
# Installs pickforge globally with bun (preferred) or npm.
# Never uses sudo.
set -eu

warned_legacy_envs=""
warn_legacy_env() {
  legacy_name="$1"
  current_name="$2"
  case " ${warned_legacy_envs} " in
    *" ${legacy_name} "*) return ;;
  esac
  warned_legacy_envs="${warned_legacy_envs} ${legacy_name}"
  echo "warning: ${legacy_name} is deprecated; use ${current_name} instead" >&2
}

resolve_package_spec() {
  package_spec="pickforge"
  tarball="${PICKFORGE_INSTALL_FROM_TARBALL:-}"
  if [ "${PICKFORGE_INSTALL_FROM_TARBALL+set}" != "set" ] && [ "${PICKLAB_INSTALL_FROM_TARBALL+set}" = "set" ]; then
    warn_legacy_env PICKLAB_INSTALL_FROM_TARBALL PICKFORGE_INSTALL_FROM_TARBALL
    tarball="${PICKLAB_INSTALL_FROM_TARBALL}"
  fi
  if [ "${tarball}" != "" ]; then
    if [ ! -f "${tarball}" ]; then
      echo "error: PICKFORGE_INSTALL_FROM_TARBALL points to a missing file: ${tarball}" >&2
      exit 1
    fi
    package_spec="${tarball}"
  fi
}

resolve_runtime() {
  runtime="${PICKFORGE_INSTALL_RUNTIME:-}"
  if [ "${PICKFORGE_INSTALL_RUNTIME+set}" != "set" ] && [ "${PICKLAB_INSTALL_RUNTIME+set}" = "set" ]; then
    warn_legacy_env PICKLAB_INSTALL_RUNTIME PICKFORGE_INSTALL_RUNTIME
    runtime="${PICKLAB_INSTALL_RUNTIME}"
  fi
  if [ "${runtime}" = "" ]; then
    if command -v bun >/dev/null 2>&1; then
      runtime="bun"
    elif command -v npm >/dev/null 2>&1; then
      runtime="npm"
    else
      echo "error: PickLab needs bun or Node.js >= 20 with npm." >&2
      echo "Install one of them and re-run this script." >&2
      exit 1
    fi
  fi
}

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: PickLab needs Node.js ^20.19, ^22.12, or >=23, but node is not on PATH." >&2
    echo "Install a supported Node.js version (with or without bun) and re-run this script." >&2
    exit 1
  fi
  node_version="$(node -v)"
  node_major="$(printf '%s' "${node_version}" | sed 's/^v//' | cut -d. -f1)"
  node_minor="$(printf '%s' "${node_version}" | sed 's/^v//' | cut -d. -f2)"
  case "${node_major}.${node_minor}" in
    *[!0-9.]*|.*|*.)
      echo "error: could not parse the Node.js version from \"${node_version}\"" >&2
      exit 1
      ;;
  esac
  supported=0
  if [ "${node_major}" -eq 20 ] && [ "${node_minor}" -ge 19 ]; then
    supported=1
  elif [ "${node_major}" -eq 22 ] && [ "${node_minor}" -ge 12 ]; then
    supported=1
  elif [ "${node_major}" -ge 23 ]; then
    supported=1
  fi
  if [ "${supported}" -ne 1 ]; then
    echo "error: PickLab needs Node.js ^20.19, ^22.12, or >=23 (found ${node_version})." >&2
    echo "Install a supported Node.js version (with or without bun) and re-run this script." >&2
    exit 1
  fi
}

resolve_bun_bin_dir() {
  bun_bin_dir=""
  if bun_bin_dir="$(bun pm bin -g 2>/dev/null)"; then
    bun_bin_dir="$(printf '%s' "${bun_bin_dir}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ "${bun_bin_dir}" != "" ]; then
      bin_dir="${bun_bin_dir}"
      return
    fi
  fi
  bin_dir="${BUN_INSTALL:-${HOME}/.bun}/bin"
}

install_with_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "error: PICKFORGE_INSTALL_RUNTIME=bun but bun is not installed" >&2
    exit 1
  fi
  echo "Installing ${package_spec} with bun..."
  if ! bun add --global "${package_spec}"; then
    echo "error: bun add --global failed (see output above)." >&2
    exit 1
  fi
  resolve_bun_bin_dir
}

install_with_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "error: PICKFORGE_INSTALL_RUNTIME=npm but npm is not installed" >&2
    exit 1
  fi
  echo "Installing ${package_spec} with npm..."
  if ! npm install --global "${package_spec}"; then
    echo "error: npm install --global failed (see output above)." >&2
    echo "If this was a permissions error, configure a user-writable prefix" >&2
    echo "(npm config set prefix ~/.npm-global) and re-run. Do not use sudo." >&2
    exit 1
  fi
  bin_dir="$(npm prefix --global)/bin"
}

verify_install() {
  pickforge_lab_bin="${bin_dir}/pickforge-lab"
  if [ ! -x "${pickforge_lab_bin}" ]; then
    echo "error: install finished but ${pickforge_lab_bin} was not found or is not executable" >&2
    exit 1
  fi
  version="$("${pickforge_lab_bin}" --version)"
  echo "pickforge-lab ${version} installed."
  resolved="$(command -v pickforge-lab 2>/dev/null || true)"
  if [ "${resolved}" = "" ]; then
    echo "note: ${bin_dir} is not on your PATH; add it to run \"pickforge-lab\" directly."
  elif [ "${resolved}" != "${pickforge_lab_bin}" ]; then
    echo "note: \"pickforge-lab\" on PATH is ${resolved}; this install wrote ${pickforge_lab_bin}."
    echo "note: if those differ, remove the other install or reorder PATH."
  fi
  echo "Next steps:"
  echo "  1. pickforge-lab agents install <codex|claude-code|cursor>  # register the MCP server"
  echo "  2. pickforge-lab init --profile <flutter-desktop|android|desktop+android>  # inside your project"
  echo "  3. pickforge-lab doctor  # verify dependencies; --fix repairs what it can"
  echo "Agent-driven setup guide: https://github.com/pickforge/pickforge/blob/main/INSTALL.md"
}

main() {
  resolve_package_spec
  check_node_version
  resolve_runtime

  case "${runtime}" in
    bun)
      install_with_bun
      ;;
    npm)
      install_with_npm
      ;;
    *)
      echo "error: unsupported PICKFORGE_INSTALL_RUNTIME \"${runtime}\" (expected bun or npm)" >&2
      exit 1
      ;;
  esac

  verify_install
}

main "$@"
