#!/bin/sh
# Pickforge installer: curl -fsSL https://pickforge.dev/install.sh | sh
# Installs the pickforge npm package and matching Rust binary side by side.
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
  package_spec="pickforge@next"
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
      echo "error: Pickforge needs bun or Node.js >= 20 with npm." >&2
      echo "Install one of them and re-run this script." >&2
      exit 1
    fi
  fi
}

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: Pickforge needs Node.js ^20.19, ^22.12, or >=23, but node is not on PATH." >&2
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
    echo "error: Pickforge needs Node.js ^20.19, ^22.12, or >=23 (found ${node_version})." >&2
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

verify_typescript_install() {
  pickforge_lab_bin="${bin_dir}/pickforge-lab"
  pickforge_mcp_bin="${bin_dir}/pickforge-mcp"
  if [ ! -x "${pickforge_lab_bin}" ] || [ ! -x "${pickforge_mcp_bin}" ]; then
    echo "error: install finished but the pickforge-lab and pickforge-mcp binaries were not both found in ${bin_dir}" >&2
    exit 1
  fi
  version="$("${pickforge_lab_bin}" --version)"
  case "${version}" in
    ""|*[!0-9A-Za-z.+-]*)
      echo "error: installed pickforge-lab returned an invalid version: ${version}" >&2
      exit 1
      ;;
  esac
  echo "pickforge-lab ${version} and pickforge-mcp installed."
}

resolve_rust_target() {
  kernel="$(uname -s)"
  machine="$(uname -m)"
  case "${kernel}:${machine}" in
    Linux:x86_64|Linux:amd64)
      rust_target="linux-x86_64"
      ;;
    Darwin:arm64|Darwin:aarch64)
      rust_target="macos-arm64"
      ;;
    *)
      echo "error: the Rust pickforge binary is not available for ${kernel} ${machine}." >&2
      echo "pickforge-lab and pickforge-mcp were installed and still work on this target." >&2
      return 1
      ;;
  esac
}

download_file() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${url}" -o "${destination}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "${url}" -O "${destination}"
  else
    echo "error: downloading the Rust binary needs curl or wget" >&2
    return 1
  fi
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | cut -d' ' -f1
  else
    echo "error: verifying the Rust binary needs sha256sum or shasum" >&2
    return 1
  fi
}

verify_checksum() {
  file="$1"
  checksum_file="$2"
  expected="$(sed -n '1{s/[[:space:]].*$//;p;}' "${checksum_file}")"
  if [ "${#expected}" -ne 64 ]; then
    echo "error: release checksum is not a valid SHA-256 value" >&2
    return 1
  fi
  case "${expected}" in
    *[!0-9A-Fa-f]*)
      echo "error: release checksum is not a valid SHA-256 value" >&2
      return 1
      ;;
  esac
  actual="$(sha256_file "${file}")" || return 1
  expected="$(printf '%s' "${expected}" | tr 'A-F' 'a-f')"
  if [ "${actual}" != "${expected}" ]; then
    echo "error: checksum verification failed for the Rust pickforge binary" >&2
    return 1
  fi
}

install_rust_binary() {
  resolve_rust_target || return 1
  asset="pickforge-${rust_target}"
  default_base_url="https://github.com/pickforge/pickforge/releases/download/v${version}"
  release_base_url="${PICKFORGE_INSTALL_RELEASE_BASE_URL:-${default_base_url}}"
  temp_dir="$(mktemp -d "${bin_dir}/.pickforge-install.XXXXXX")"
  trap 'rm -rf "${temp_dir}"' EXIT HUP INT TERM

  echo "Installing Rust pickforge ${version} for ${rust_target}..."
  download_file "${release_base_url}/${asset}" "${temp_dir}/${asset}"
  download_file "${release_base_url}/${asset}.sha256" "${temp_dir}/${asset}.sha256"
  verify_checksum "${temp_dir}/${asset}" "${temp_dir}/${asset}.sha256"
  chmod 0755 "${temp_dir}/${asset}"
  rust_version="$("${temp_dir}/${asset}" --version 2>/dev/null || true)"
  if [ "${rust_version}" != "pickforge ${version}" ]; then
    echo "error: downloaded Rust binary reported \"${rust_version}\"; expected \"pickforge ${version}\"" >&2
    return 1
  fi
  mv "${temp_dir}/${asset}" "${bin_dir}/pickforge"
  rm -rf "${temp_dir}"
  trap - EXIT HUP INT TERM
  echo "pickforge ${version} installed at ${bin_dir}/pickforge."
}

print_path_note() {
  resolved="$(command -v pickforge-lab 2>/dev/null || true)"
  if [ "${resolved}" = "" ]; then
    echo "note: ${bin_dir} is not on your PATH; add it to run Pickforge directly."
  elif [ "${resolved}" != "${pickforge_lab_bin}" ]; then
    echo "note: \"pickforge-lab\" on PATH is ${resolved}; this install wrote ${pickforge_lab_bin}."
    echo "note: if those differ, remove the other install or reorder PATH."
  fi
}

print_next_steps() {
  echo "Next steps:"
  echo "  1. pickforge doctor"
  echo "  2. pickforge init"
  echo "  3. pickforge-lab agents install <codex|claude-code|cursor|pi>"
  echo "Flutter quickstart: https://github.com/pickforge/pickforge#quickstart"
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

  verify_typescript_install
  install_rust_binary
  print_path_note
  print_next_steps
}

main "$@"
