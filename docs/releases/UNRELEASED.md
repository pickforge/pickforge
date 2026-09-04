# Pickforge 0.4.0-alpha.2

Draft release notes for the second Pickforge prerelease. `0.4.0-alpha.1` is
published; its notes live on the GitHub release. Use this file as the next
release description, then reset it after that release is published.

## Flutter integration is the normal path

- `pickforge init` always configures the Flutter integration: the owned
  `pickforge-dart` server as `dart mcp-server` and the portable
  `pickforge-flutter` workflow for Claude Code, Codex, and Pi. It requires
  `dart` on PATH and fails before writing anything otherwise.
- The temporary `--mobile-integration-alpha` flag is removed, along with its
  prerelease-only default. Stable and prerelease builds behave the same.
- Receipt remediation messages now point at plain `pickforge init`.
- Legacy `PICKLAB_*` environment variables keep working with a deprecation
  warning through the 0.4 release train.

## Run storage hardening

- Run directories are now created through the same lstat/realpath trust
  boundary the run catalog uses when reading (#54). In `project-local` mode a
  symlinked `.picklab` or `.picklab/runs`, whether committed in the repository
  or planted later, is refused with a clear error instead of redirecting
  screenshots and manifests. `home` and `custom` modes verify their
  `projects/<id>/runs` and `runs` components the same way.
- Manifest writes through a run handle re-verify the run directory's identity,
  so a directory swapped for a symlink after creation cannot redirect later
  writes. Evidence runs adopt and finalize through the same bound handles.
- Nothing is migrated, replaced, or deleted when an unsafe entry is found; the
  offending path is named in the error.

## Validation

- Updated during release preparation.

## Known limits

- Node.js has no directory-handle-relative `mkdir`, so a swap between the
  verification and the creation of one directory level is detected after the
  fact and reported rather than prevented; no manifest or artifact is written
  through a redirected path.
