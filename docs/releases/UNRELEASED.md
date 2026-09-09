# Pickforge 0.4.0

Pickforge 0.4.0 is the first stable release of the renamed project: a Flutter-first integration CLI for Claude Code, Codex, and Pi, plus a Linux desktop, headed browser, and Android emulator lab. It ships the 0.4.0-beta.1 code with the fixes found during the beta soak, an opt-in telemetry contract, and a support matrix backed by published evidence.

## Changes

- Stable install path. `npm install -g pickforge` and `curl -fsSL https://pickforge.dev/install.sh | sh` install the stable release; prereleases stay on the `next` dist-tag. The README, INSTALL guide, and CLI help carry the evidence-based support matrix: Flutter deep integration on Linux x86_64 and macOS arm64, Linux Xvfb desktop and headed browser lab, Android APK and emulator automation (a 3 GB guest is the tested memory floor), and Claude Code, Codex, and Pi as verified harnesses. React Native, native iOS, and a Windows lab are unsupported.
- Fatal-error telemetry is disabled by default in the TypeScript CLI and MCP server, with no Sentry initialization or traffic. Opt in with `PICKFORGE_TELEMETRY=1`, `true`, or `on`; any other value or unset disables it. Enabled reports send redacted error messages and stacks plus OS, Node.js, and app versions, not product analytics. Legacy `PICKLAB_TELEMETRY` remains a fallback for the 0.4 train with one deprecation warning.
- `pickforge-mcp --version` and `--help` print and exit instead of starting the stdio server.
- `pickforge-lab agents install` and `agents link` register only the `pickforge-lab` MCP server by default; pass `--browser` to also register the browser DevTools relay, which cannot start until a browser session exists. Existing browser entries, including migrated legacy `picklab-browser` registrations, are retained and reported.
- `pickforge-lab doctor` exits 1 when required checks are missing, in text and JSON modes. Warnings alone still exit 0. Checks reflect the state before `--fix`.
- Desktop, browser, and Android teardown retain session logs while removing runtime data and permits; failed starts keep their diagnostics. `pickforge-lab session prune --older-than <duration>` or `--all-stopped` removes retained logs explicitly; nothing is pruned automatically.
- `pickforge-lab artifacts report --finalize-orphans` and MCP `artifact_report` with `finalizeOrphans: true` recover evidence runs whose owner process died, mark them orphaned, rebuild reports from the append-only journal, and write one session index. Journals are never rewritten or deleted.
- Browser labs redirect GCM transports to an unusable loopback endpoint and disable Web Push, component updates, phishing checks, reliability reporting, server-backed autofill, and Optimization Guide features. Sessions can still reach the network; there is no zero-egress guarantee.
- The Pi MCP config path is fixed at `$HOME/.config/mcp/mcp.json` because pi-mcp-adapter ignores `XDG_CONFIG_HOME`; docs and the init plan say so.
- Dependencies: esbuild 0.28.1 removes the last OSV exception for the build chain; the test runner advisory GHSA-82fw-gwwq-j7x9 (devDependency only) is tracked in #132. oxlint replaces ESLint as the lint gate with the same complexity, depth, and length limits.

## Validation

- Release CI runs the clean Linux container and Apple silicon candidate smokes on the exact published artifacts before publishing.
- The stable candidate passed the Linux desktop, Android emulator, macOS, and Claude Code, Codex, and Pi device and harness gates with independent visual review; evidence is recorded under `~/Projects/Boards/pickforge/0.4-release/stable-candidate/` and linked from #89.

## Known limits

- The TypeScript lab is Linux-only. macOS support covers the Rust integration CLI (`doctor`, `init`, evidence) and the generated Dart MCP; it was proven with a disposable Flutter fixture, not the desktop, browser, or Android lab.
- Android: a 2 GB emulator guest was killed by lowmemorykiller during the beta pass; the tested journey used a 3 GB guest. Use at least 3 GB.
- No successful headed-browser journey is part of the 0.4.0 evidence packets; the browser lab is supported on the strength of the alpha-era acceptance pass, and real-browser egress acceptance for the new Chrome switches remains pending (#112).
- Desktop containment owns processes started in a session; it is not a security sandbox for hostile code.
- Evidence pointers and locks do not record a hostname, so pid probes on shared storage are meaningless. Orphaned runs are never pruned by retention, and session index links can dangle after retention.
- The macOS asset is ad-hoc signed and not notarized (`docs/releases/SIGNING.md`).
