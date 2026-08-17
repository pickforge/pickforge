# Unreleased

Working draft for the next PickLab release. Use this to polish the generated
GitHub release description, then reset it after the release is published.

## User-facing changes

- None yet.

## Internal/release changes

- Raised the vulnerable `fast-uri` and `hono` overrides, plus lockfile
  resolutions for both `brace-expansion` majors, `fast-uri`, `hono`,
  `ip-address`, and `nanoid`, to patched releases.

## Validation

### Tested

- Pinned Bun 1.3.12 CI: frozen install, typecheck, lint, 1,133 tests pass,
  one skips, coverage passes at 82.48% lines, and build passes.
- The pinned OSV Scanner v2.3.8 image reports no unfiltered advisories.

### Not tested yet

- None recorded.

### Release blockers

- None known.
