# Pickforge release checklist

Owner-only steps for any Pickforge release. Nothing here is pinned to one
version: set `VERSION` once and run the commands as written. Stop on the first
failure. Do not reuse or move a release tag. Do not publish the GitHub draft
until every gate below is green.

```sh
export VERSION=0.4.0-alpha.2      # the version being released
export TAG="v${VERSION}"
export REPO=pickforge/pickforge
cd ~/Projects/Pickforge/picklab
```

Prereleases (`X.Y.Z-*`) publish to the npm `next` dist-tag and create a GitHub
*prerelease* draft. Stable versions publish to `latest` and create a normal
draft. Everything else in this checklist is identical.

## 1. Prepare a clean release checkout

```sh
git fetch origin --prune
git switch main
git pull --ff-only
test -z "$(git status --porcelain)"
test "$(node scripts/check-release-versions.mjs "$TAG")" = "$VERSION"
```

`scripts/check-release-versions.mjs` is the single source of truth for version
consistency: it checks every workspace package, the root manifest, the Cargo
workspace, and the tag. The release workflow runs the same script.

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
cargo test --workspace --locked
cargo build --release --locked
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

## 5. Optional: run the candidate smoke locally

The release workflow runs this automatically (steps 7 and 8). Run it locally
only when you are debugging the gate itself. It installs *only* candidate
artifacts into an isolated home, and touches neither your real home nor the
generated project tree.

```sh
bun run build
cargo build --release --locked
rm -rf /tmp/candidate && mkdir -p /tmp/candidate/npm /tmp/candidate/assets
(cd packages/cli && npm pack --pack-destination /tmp/candidate/npm)
cp target/release/pickforge /tmp/candidate/assets/pickforge-linux-x86_64
strip /tmp/candidate/assets/pickforge-linux-x86_64
(cd /tmp/candidate/assets && sha256sum pickforge-linux-x86_64 > pickforge-linux-x86_64.sha256)
rm -rf /tmp/smoke-evidence && mkdir -m 777 /tmp/smoke-evidence
docker run --rm --platform linux/amd64 \
  -v "$PWD/scripts:/opt/pickforge/scripts:ro" \
  -v /tmp/candidate:/opt/pickforge/candidate:ro \
  -v /tmp/smoke-evidence:/opt/pickforge/evidence \
  -e "PICKFORGE_SMOKE_VERSION=$VERSION" \
  -e PICKFORGE_SMOKE_ASSET_DIR=/opt/pickforge/candidate/assets \
  -e "PICKFORGE_SMOKE_TARBALL=/opt/pickforge/candidate/npm/pickforge-${VERSION}.tgz" \
  -e PICKFORGE_SMOKE_EVIDENCE=/opt/pickforge/evidence \
  ghcr.io/cirruslabs/flutter:stable bash -lc '
    set -eu
    apt-get update -qq
    apt-get install -y --no-install-recommends ca-certificates curl >/dev/null 2>&1
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y --no-install-recommends nodejs >/dev/null 2>&1
    exec /opt/pickforge/scripts/candidate-smoke.sh
  '
cat /tmp/smoke-evidence/summary.md
```

On an Apple silicon Mac, run the same script against a downloaded asset:

```sh
PICKFORGE_SMOKE_VERSION="$VERSION" \
PICKFORGE_SMOKE_ASSET_DIR=/absolute/path/release-assets \
PICKFORGE_SMOKE_ASSET=pickforge-macos-arm64 \
PICKFORGE_SMOKE_EXPECT_ARCH=arm64 \
  bash scripts/candidate-smoke.sh
```

## 6. Write the release notes

`docs/releases/UNRELEASED.md` is the release description. It must read as
public notes: no drafting instructions, no "to be updated" placeholders, and no
claim about validation that has not actually happened. The publish job passes
this file to `gh release create --notes-file`.

```sh
$EDITOR docs/releases/UNRELEASED.md
grep -n -i -E 'draft|to be updated|not executed|TODO' docs/releases/UNRELEASED.md   # must print nothing
git commit -am "docs(release): notes for $VERSION"
git push origin main
```

## 7. Optional: dry-run the release workflow

A manual dispatch with an empty (or non-matching) `confirm` input builds the
candidate artifacts, runs both smokes and every gate, and publishes nothing.
The publish job is the only job with `contents: write` and `id-token: write`,
and it does not run unless `confirm` is exactly `$TAG` on `main`.

```sh
gh workflow run release.yml --repo "$REPO" --ref main -f confirm=
sleep 10
RUN_ID="$(gh run list --repo "$REPO" --workflow release.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status
```

Download the evidence the smokes uploaded:

```sh
gh run download "$RUN_ID" --repo "$REPO" \
  -n candidate-smoke-linux -n candidate-smoke-macos -D /tmp/candidate-evidence
cat /tmp/candidate-evidence/summary.md
```

## 8. Create the tag and wait for the release workflow

The owner creates and pushes the tag. This is the point at which the workflow
may publish through npm OIDC — and only after the clean Linux container smoke,
the Apple silicon smoke, and the lab and Rust gates have all passed.

```sh
test -z "$(git status --porcelain)"
test "$(git branch --show-current)" = main
git pull --ff-only
git tag -a "$TAG" -m "Pickforge $VERSION"
git push origin "$TAG"
sleep 10
RUN_ID="$(gh run list --repo "$REPO" --workflow release.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status
```

## 9. Inspect the draft and its assets

```sh
RELEASE_JSON="$(gh release view "$TAG" --repo "$REPO" --json isDraft,isPrerelease,assets,url)"
printf '%s\n' "$RELEASE_JSON" | jq .
test "$(printf '%s' "$RELEASE_JSON" | jq -r .isDraft)" = true
ASSET_DIR="$(mktemp -d)"
gh release download "$TAG" --repo "$REPO" --dir "$ASSET_DIR"
(
  cd "$ASSET_DIR"
  sha256sum -c pickforge-linux-x86_64.sha256
  sha256sum -c pickforge-macos-arm64.sha256
)
chmod +x "$ASSET_DIR/pickforge-linux-x86_64"
test "$($ASSET_DIR/pickforge-linux-x86_64 --version)" = "pickforge $VERSION"
```

The asset list must be exactly:

- `pickforge-linux-x86_64`
- `pickforge-linux-x86_64.sha256`
- `pickforge-macos-arm64`
- `pickforge-macos-arm64.sha256`

The workflow already executed both binaries on their own platforms. Confirm the
published assets are the smoked ones by comparing the checksums above with the
`candidate-smoke-linux` and `candidate-smoke-macos` evidence from the same run.

## 10. Publish and verify the public paths

Only after every earlier step is green:

```sh
gh release edit "$TAG" --repo "$REPO" --draft=false
PUBLIC_ASSET_DIR="$(mktemp -d)"
for file in pickforge-linux-x86_64 pickforge-linux-x86_64.sha256; do
  curl -fsSL "https://github.com/$REPO/releases/download/$TAG/$file" \
    -o "$PUBLIC_ASSET_DIR/$file"
done
(cd "$PUBLIC_ASSET_DIR" && sha256sum -c pickforge-linux-x86_64.sha256)
npm view "pickforge@$VERSION" version
npm view pickforge dist-tags --json
curl -fsSL https://pickforge.dev/install.sh | head -n 5
```

Require all of these final facts:

- The GitHub release is public, and marked prerelease exactly when `$VERSION`
  is a prerelease.
- `npm view pickforge@$VERSION version` matches `$VERSION`, and `latest` moved
  only for a stable release.
- Both Rust targets and both checksum files are public.
- `https://pickforge.dev/install.sh` serves the canonical installer.

## 11. Reset the notes for the next release

The published GitHub release text is now the source of truth for `$VERSION`.

```sh
cp docs/releases/TEMPLATE.md docs/releases/UNRELEASED.md
git commit -am "docs(release): reset unreleased notes after $VERSION"
git push origin main
```

If anything fails after the npm publish or the tag push, leave the GitHub
release as a draft and fix forward with a new version and tag. Never move or
overwrite a published tag.

## One-time setup (done; kept for recovery)

Not part of a normal release:

- The first `pickforge` publish was done by hand from a verified tree, because
  a trusted publisher cannot create a new npm package.
- npm trusted publishing is configured on the `pickforge` package with
  organization `pickforge`, repository `pickforge`, workflow `release.yml`, and
  no environment. Re-check these values if a publish fails OIDC.
- The macOS signing and notarization policy lives in
  [SIGNING.md](SIGNING.md) and is enforced by the macOS candidate smoke.
