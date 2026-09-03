# Pickforge release checklist

These are the owner-only steps for `0.4.0-alpha.1`. Stop on the first failure.
Do not reuse or move a release tag. Do not publish the GitHub draft until the
live, device, artifact, and clean-machine checks pass.

## 1. Prepare a clean release checkout

Run this only after the repository rename, PR #83, and the alpha-gate PR have
merged to `main` with green checks.

```sh
export VERSION=0.4.0-alpha.1
export TAG="v${VERSION}"
cd ~/Projects/Pickforge/picklab
git fetch origin --prune
git switch main
git pull --ff-only
test -z "$(git status --porcelain)"
test "$(node -p "require('./packages/cli/package.json').version")" = "$VERSION"
test "$(sed -n 's/^version = "\([^"]*\)"/\1/p' Cargo.toml)" = "$VERSION"
node <<'NODE'
const fs = require("fs");
const expected = process.env.VERSION;
for (const name of fs.readdirSync("packages")) {
  const path = `packages/${name}/package.json`;
  if (!fs.existsSync(path)) continue;
  const actual = JSON.parse(fs.readFileSync(path, "utf8")).version;
  if (actual !== expected) throw new Error(`${path}: ${actual} != ${expected}`);
}
NODE
```

Confirm the tag does not exist locally or remotely:

```sh
! git rev-parse "$TAG" >/dev/null 2>&1
! git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1
```

## 2. Run the local gates

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run build
cargo fmt --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test -p pickforge-cli
cargo build --release --locked
```

Verify the host Rust binary directly:

```sh
./target/release/pickforge --version
test "$(./target/release/pickforge --version)" = "pickforge $VERSION"
```

## 3. Run the opt-in live Flutter test

Use a real Flutter SDK and a disposable Flutter project. This test is never
silently replaced by a mock.

```sh
PICKFORGE_LIVE_FLUTTER=1 cargo test -p pickforge-cli --test live_flutter
```

Stop if the live target is absent, skipped, or fails.

## 4. Run the device pass

Use the workspace `device-pass` skill on the same real Flutter flow documented
in the README:

1. Run `pickforge doctor`, then `pickforge init`.
2. Start the app with `pickforge-lab desktop exec` inside a desktop session.
3. Inspect, click, edit only the intended Dart source, hot reload, and repeat
   the same runtime scenario.
4. Capture before and after screenshots and run `pickforge evidence record`.
5. Ask the skill for its independent vision verdict.

Record the device, OS, Flutter version, evidence report path, and screenshot
paths in the release log. Continue only with an explicit `PASS` vision verdict.
`INCONCLUSIVE`, a missing screenshot, a skipped visual review, or a dirty
project tree is a release failure.

## 5. Create the npm package for the first time

A trusted publisher cannot create a new npm package. The owner performs this
one manual publish from the already verified tree:

```sh
cd ~/Projects/Pickforge/picklab
bun install --frozen-lockfile
bun run build
cd packages/cli
npm whoami
npm publish --access public --tag next
npm view pickforge@next version
npm view pickforge@next bin --json
cd ../..
test "$(npm view pickforge@next version)" = "$VERSION"
```

The bin map must contain `pickforge-lab` and `pickforge-mcp`. Do not add or move
the `latest` dist-tag.

## 6. Configure npm trusted publishing

Open the `pickforge` package settings on npm and add a GitHub Actions trusted
publisher with exactly these values:

- Organization or user: `pickforge`
- Repository: `pickforge`
- Workflow filename: `release.yml`
- Environment: leave empty

Re-open the package settings and confirm the publisher was saved before
creating the tag.

## 7. Create the tag and wait for the release workflow

The owner creates and pushes the tag. This is the first point at which the
workflow may publish through npm OIDC.

```sh
cd ~/Projects/Pickforge/picklab
test -z "$(git status --porcelain)"
test "$(git branch --show-current)" = main
git pull --ff-only
git tag -a "$TAG" -m "Pickforge $VERSION"
git push origin "$TAG"
sleep 10
RUN_ID="$(gh run list --repo pickforge/pickforge --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo pickforge/pickforge --exit-status
```

The workflow must remain green. It should skip the already completed manual npm
publish, create a draft GitHub prerelease, and attach four Rust files.

## 8. Inspect the draft and its assets

```sh
RELEASE_JSON="$(gh release view "$TAG" --repo pickforge/pickforge --json isDraft,isPrerelease,assets,url)"
printf '%s\n' "$RELEASE_JSON" | jq .
test "$(printf '%s' "$RELEASE_JSON" | jq -r .isDraft)" = true
test "$(printf '%s' "$RELEASE_JSON" | jq -r .isPrerelease)" = true
ASSET_DIR="$(mktemp -d)"
gh release download "$TAG" --repo pickforge/pickforge --dir "$ASSET_DIR"
(
  cd "$ASSET_DIR"
  sha256sum -c pickforge-linux-x86_64.sha256
  sha256sum -c pickforge-macos-arm64.sha256
)
test -x "$ASSET_DIR/pickforge-linux-x86_64" || chmod +x "$ASSET_DIR/pickforge-linux-x86_64"
test "$($ASSET_DIR/pickforge-linux-x86_64 --version)" = "pickforge $VERSION"
gh release edit "$TAG" --repo pickforge/pickforge \
  --notes-file docs/releases/UNRELEASED.md --draft --prerelease
```

Confirm the asset list is exactly:

- `pickforge-linux-x86_64`
- `pickforge-linux-x86_64.sha256`
- `pickforge-macos-arm64`
- `pickforge-macos-arm64.sha256`

Run the macOS binary on an Apple silicon machine and require the same version
output before publishing the draft:

```sh
MAC_ASSET_DIR="$(mktemp -d)"
gh release download "$TAG" --repo pickforge/pickforge --dir "$MAC_ASSET_DIR" \
  --pattern 'pickforge-macos-arm64*'
(
  cd "$MAC_ASSET_DIR"
  shasum -a 256 -c pickforge-macos-arm64.sha256
  chmod +x pickforge-macos-arm64
  test "$(./pickforge-macos-arm64 --version)" = "pickforge $VERSION"
)
```

## 9. Run the clean-machine smoke

This uses a fresh Flutter container, the published `pickforge@next` package,
and the authenticated draft assets downloaded above. A clean image has no
coding-agent harness, so `doctor` must run safely and report that single
readiness gap rather than being treated as ready.

```sh
ASSET_DIR="$(cd "$ASSET_DIR" && pwd)"
REPO_DIR="$(pwd)"
docker run --rm --platform linux/amd64 \
  -v "$REPO_DIR/scripts/install.sh:/tmp/install.sh:ro" \
  -v "$ASSET_DIR:/tmp/pickforge-assets:ro" \
  ghcr.io/cirruslabs/flutter:stable bash -lc '
    set -eu
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y --no-install-recommends nodejs
    flutter create --platforms=linux /tmp/pickforge-smoke
    export npm_config_prefix=/tmp/pickforge-prefix
    export PATH=/tmp/pickforge-prefix/bin:$PATH
    PICKFORGE_INSTALL_RUNTIME=npm \
    PICKFORGE_INSTALL_RELEASE_BASE_URL=file:///tmp/pickforge-assets \
      sh /tmp/install.sh
    test "$(pickforge --version)" = "pickforge 0.4.0-alpha.1"
    test "$(pickforge-lab --version)" = "0.4.0-alpha.1"
    set +e
    pickforge doctor --project-dir /tmp/pickforge-smoke \
      >/tmp/pickforge-doctor.txt 2>&1
    doctor_status=$?
    set -e
    cat /tmp/pickforge-doctor.txt
    test "$doctor_status" -eq 1
    grep -F "framework: flutter" /tmp/pickforge-doctor.txt
    grep -F "no supported agent harness found on PATH" /tmp/pickforge-doctor.txt
  '
```

## 10. Publish the GitHub prerelease and verify public paths

Only after every earlier step is green:

```sh
gh release edit "$TAG" --repo pickforge/pickforge --draft=false --prerelease
PUBLIC_ASSET_DIR="$(mktemp -d)"
curl -fsSL \
  "https://github.com/pickforge/pickforge/releases/download/$TAG/pickforge-linux-x86_64" \
  -o "$PUBLIC_ASSET_DIR/pickforge-linux-x86_64"
curl -fsSL \
  "https://github.com/pickforge/pickforge/releases/download/$TAG/pickforge-linux-x86_64.sha256" \
  -o "$PUBLIC_ASSET_DIR/pickforge-linux-x86_64.sha256"
(cd "$PUBLIC_ASSET_DIR" && sha256sum -c pickforge-linux-x86_64.sha256)
npm view pickforge@next version
npm view pickforge dist-tags --json
curl -fsSL https://pickforge.dev/install.sh | grep -F 'package_spec="pickforge@next"'
```

Require all of these final facts:

- The GitHub release is public and marked prerelease, not draft.
- `pickforge@next` resolves to `0.4.0-alpha.1`; `latest` was not moved.
- Both Rust targets and both checksum files are public.
- `https://pickforge.dev/install.sh` serves the canonical alpha installer.

If anything fails after the npm publish or tag push, leave the GitHub release as
a draft and fix forward with a new version and tag. Never move or overwrite a
published tag.
