# Pickforge rename and alpha runbook

Run these steps only after the relevant PRs are approved and the rename wave is
ready. The rename PR merges immediately after the repository renames below.
The alpha-gate PR merges after the rename and ends at a draft release until its
owner-only checks pass.

## 1. Rename the GitHub repositories

The existing IDE repository must move first so the `pickforge` name is free.

```sh
gh repo rename --repo pickforge/pickforge pickforge-ide --yes
gh repo rename --repo pickforge/picklab pickforge --yes

gh repo view pickforge/pickforge-ide --json nameWithOwner,url
gh repo view pickforge/pickforge --json nameWithOwner,url
```

## 2. Update local remotes

```sh
git -C ~/Projects/Pickforge/pickforge remote set-url origin git@github.com:pickforge/pickforge-ide.git
git -C ~/Projects/Pickforge/picklab remote set-url origin git@github.com:pickforge/pickforge.git

git -C ~/Projects/Pickforge/pickforge remote -v
git -C ~/Projects/Pickforge/picklab remote -v
```

## 3. Merge the rename wave

Merge this PR into `main` only after `pickforge/picklab` has become
`pickforge/pickforge`. Do not merge it while the old repository name is still
active.

## 4. Create the unscoped npm package manually

A new npm package cannot be created by the release workflow's OIDC trusted
publisher. The first publish must be manual.

```sh
cd ~/Projects/Pickforge/picklab
git fetch origin
git switch main
git pull --ff-only
test "$(node -p "require('./packages/cli/package.json').version")" = "0.4.0-alpha.1"
bun install --frozen-lockfile
bun run build
cd packages/cli
npm whoami
npm publish --access public --tag next
npm view pickforge@next version
npm view pickforge@next bin --json
cd ../..
```

## 5. Configure npm trusted publishing

After the manual publish, open the `pickforge` package settings on npm and add
a GitHub Actions trusted publisher with these exact values:

- Organization or user: `pickforge`
- Repository: `pickforge`
- Workflow filename: `release.yml`
- Environment: leave empty

Confirm the publisher before creating the release tag. The workflow at
`.github/workflows/release.yml` publishes with provenance and adds the `next`
tag because `0.4.0-alpha.1` is a prerelease.

## 6. Cut and verify the alpha

Follow [docs/releases/CHECKLIST.md](docs/releases/CHECKLIST.md) exactly. It is
the authoritative sequence for local gates, the opt-in live Flutter test, the
real-device vision pass, tag creation, workflow monitoring, draft asset checks,
the clean-machine installer smoke, and final prerelease publication.

Do not publish the GitHub draft until every checklist gate is green. The owner
creates and pushes the tag; no implementation or review agent does so.

## 7. Deprecate the old package later

Do this only after the new package and install path have been verified.

```sh
npm deprecate @pickforge/picklab@'*' 'Renamed to pickforge'
```

## 8. Verification checklist

```sh
gh repo view pickforge/pickforge --json nameWithOwner,url
git -C ~/Projects/Pickforge/picklab ls-remote origin HEAD
npm view pickforge@next version
npm view pickforge@next dist-tags --json
npm view pickforge@next bin --json
npm exec --yes --package=pickforge@next -- pickforge-lab --version
curl -fsSL https://pickforge.dev/install.sh | grep -F 'package_spec="pickforge@next"'
gh release view v0.4.0-alpha.1 --repo pickforge/pickforge --json isDraft,isPrerelease,assets,url
npm view @pickforge/picklab deprecated
```

Check all of the following:

- `pickforge/pickforge-ide` is the former IDE repository.
- `pickforge/pickforge` is this repository.
- `pickforge@next` resolves to `0.4.0-alpha.1`.
- The package exposes `pickforge-lab` and `pickforge-mcp`.
- The release workflow names `pickforge` as its trusted-publisher package.
- The GitHub prerelease has both Rust target binaries and both `.sha256` files.
- `pickforge-lab doctor` prints the active state directory.
- Linking Claude Code, Codex, or Pi writes `pickforge-lab` and replaces an
  owned legacy `picklab` entry.
- Existing state remains present under `~/.pickforge/picklab/` and
  `~/.picklab/`; new TypeScript state is written under `~/.pickforge/lab/`.
- The old npm package is deprecated only after the new package works.
