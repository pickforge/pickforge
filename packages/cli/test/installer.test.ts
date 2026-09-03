import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliPackageDir = path.join(repoRoot, "packages", "cli");
const installScript = path.join(repoRoot, "scripts", "install.sh");
const cliVersion = (
  JSON.parse(
    fs.readFileSync(path.join(cliPackageDir, "package.json"), "utf8"),
  ) as { version: string }
).version;

const NETWORK_TIMEOUT = 300_000;

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function describeFailure(result: ExecResult): string {
  return `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

let suiteDir: string;
let tarball: string;
let npmCache: string;
let releaseBaseUrl: string;

function makeCase(name: string): { home: string; dir: string } {
  const dir = path.join(suiteDir, name);
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  return { home, dir };
}

function writeExecutable(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    contents.endsWith("\n") ? contents : `${contents}\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(file, 0o755);
}

function baseEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PICKFORGE_HOME: path.join(home, ".pickforge", "lab"),
    PICKFORGE_INSTALL_RELEASE_BASE_URL: releaseBaseUrl,
    PATH: process.env.PATH ?? "",
    npm_config_cache: npmCache,
    ...extra,
  };
}

function hasBun(): boolean {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, "bun"), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

beforeAll(async () => {
  await ensureCliBuilt();
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-installer-"));
  npmCache = path.join(suiteDir, "npm-cache");
  fs.mkdirSync(npmCache, { recursive: true });

  const releaseDir = path.join(suiteDir, "release");
  const rustAsset = path.join(releaseDir, "pickforge-linux-x86_64");
  writeExecutable(
    rustAsset,
    [
      "#!/bin/sh",
      "if [ \"${1:-}\" = \"--version\" ]; then",
      `  printf '%s\\n' 'pickforge ${cliVersion}'`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n"),
  );
  const rustHash = createHash("sha256")
    .update(fs.readFileSync(rustAsset))
    .digest("hex");
  fs.writeFileSync(`${rustAsset}.sha256`, `${rustHash}  pickforge-linux-x86_64\n`);
  releaseBaseUrl = pathToFileURL(releaseDir).href;

  const packDir = path.join(suiteDir, "pack");
  fs.mkdirSync(packDir, { recursive: true });
  const packed = await run(
    "npm",
    ["pack", "--pack-destination", packDir, "--json"],
    { cwd: cliPackageDir, env: baseEnv(path.join(suiteDir, "pack-home")) },
  );
  if (packed.code !== 0) {
    throw new Error(`npm pack failed: ${describeFailure(packed)}`);
  }
  const [entry] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarball = path.join(packDir, entry.filename);
  if (!fs.existsSync(tarball)) {
    throw new Error(`packed tarball not found at ${tarball}`);
  }
}, NETWORK_TIMEOUT);

afterAll(() => {
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

describe("install.sh", () => {
  it("passes a POSIX sh syntax check", async () => {
    const result = await run("sh", ["-n", installScript], {
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.code, describeFailure(result)).toBe(0);
  });

  it(
    "installs from a tarball with npm into a user prefix and verifies the binary",
    async () => {
      const { home, dir } = makeCase("sh-npm");
      const prefix = path.join(dir, "prefix");
      const env = baseEnv(home, {
        PICKFORGE_INSTALL_FROM_TARBALL: tarball,
        PICKFORGE_INSTALL_RUNTIME: "npm",
        npm_config_prefix: prefix,
      });
      const result = await run("sh", [installScript], { cwd: dir, env });
      expect(result.code, describeFailure(result)).toBe(0);
      expect(result.stdout).toContain(
        `pickforge-lab ${cliVersion} and pickforge-mcp installed.`,
      );
      expect(result.stdout).toContain(`pickforge ${cliVersion} installed at`);
      expect(result.stdout).toContain("pickforge-lab agents install");
      expect(result.stdout).toContain("pickforge doctor");

      const binary = path.join(prefix, "bin", "pickforge-lab");
      const version = await run(binary, ["--version"], { env: baseEnv(home) });
      expect(version.code, describeFailure(version)).toBe(0);
      expect(version.stdout.trim()).toBe(cliVersion);
      const rustVersion = await run(
        path.join(prefix, "bin", "pickforge"),
        ["--version"],
        { env: baseEnv(home) },
      );
      expect(rustVersion.code, describeFailure(rustVersion)).toBe(0);
      expect(rustVersion.stdout.trim()).toBe(`pickforge ${cliVersion}`);
    },
    NETWORK_TIMEOUT,
  );

  it(
    "rejects a Rust binary whose checksum does not match",
    async () => {
      const { home, dir } = makeCase("sh-bad-checksum");
      const prefix = path.join(dir, "prefix");
      const badReleaseDir = path.join(dir, "release");
      const rustAsset = path.join(badReleaseDir, "pickforge-linux-x86_64");
      fs.mkdirSync(badReleaseDir, { recursive: true });
      fs.copyFileSync(
        path.join(fileURLToPath(releaseBaseUrl), "pickforge-linux-x86_64"),
        rustAsset,
      );
      fs.writeFileSync(`${rustAsset}.sha256`, `${"0".repeat(64)}  pickforge-linux-x86_64\n`);

      const result = await run("sh", [installScript], {
        cwd: dir,
        env: baseEnv(home, {
          PICKFORGE_INSTALL_FROM_TARBALL: tarball,
          PICKFORGE_INSTALL_RUNTIME: "npm",
          PICKFORGE_INSTALL_RELEASE_BASE_URL: pathToFileURL(badReleaseDir).href,
          npm_config_prefix: prefix,
        }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("checksum verification failed");
      expect(fs.existsSync(path.join(prefix, "bin", "pickforge-lab"))).toBe(true);
      expect(fs.existsSync(path.join(prefix, "bin", "pickforge"))).toBe(false);
    },
    NETWORK_TIMEOUT,
  );

  it(
    "refuses unsupported Rust targets after installing the TypeScript commands",
    async () => {
      const { home, dir } = makeCase("sh-unsupported-target");
      const prefix = path.join(dir, "prefix");
      const fakeBin = path.join(dir, "bin");
      writeExecutable(
        path.join(fakeBin, "uname"),
        [
          "#!/bin/sh",
          "if [ \"${1:-}\" = \"-s\" ]; then printf '%s\\n' Plan9; else printf '%s\\n' wasm64; fi",
        ].join("\n"),
      );

      const result = await run("/bin/sh", [installScript], {
        cwd: dir,
        env: baseEnv(home, {
          PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
          PICKFORGE_INSTALL_FROM_TARBALL: tarball,
          PICKFORGE_INSTALL_RUNTIME: "npm",
          npm_config_prefix: prefix,
        }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not available for Plan9 wasm64");
      expect(result.stderr).toContain(
        "pickforge-lab and pickforge-mcp were installed and still work",
      );
      expect(fs.existsSync(path.join(prefix, "bin", "pickforge-lab"))).toBe(true);
      expect(fs.existsSync(path.join(prefix, "bin", "pickforge"))).toBe(false);
    },
    NETWORK_TIMEOUT,
  );

  it(
    "creates the global home and project config via init from the installed binary",
    async () => {
      const { home, dir } = makeCase("sh-init");
      const prefix = path.join(dir, "prefix");
      const project = path.join(dir, "project");
      fs.mkdirSync(project, { recursive: true });
      const install = await run("sh", [installScript], {
        cwd: dir,
        env: baseEnv(home, {
          PICKFORGE_INSTALL_FROM_TARBALL: tarball,
          PICKFORGE_INSTALL_RUNTIME: "npm",
          npm_config_prefix: prefix,
        }),
      });
      expect(install.code, describeFailure(install)).toBe(0);

      const pickforgeHome = path.join(home, ".pickforge", "lab");
      expect(fs.existsSync(pickforgeHome)).toBe(false);
      const init = await run(
        path.join(prefix, "bin", "pickforge-lab"),
        ["init", "--profile", "generic", "--yes", "--json"],
        { cwd: project, env: baseEnv(home) },
      );
      expect(init.code, describeFailure(init)).toBe(0);
      const report = JSON.parse(init.stdout) as Record<string, any>;
      expect(report.ok).toBe(true);
      expect(fs.existsSync(pickforgeHome)).toBe(true);
      const config = JSON.parse(
        fs.readFileSync(path.join(project, ".picklab", "config.json"), "utf8"),
      );
      expect(config.profile).toBe("generic");
    },
    NETWORK_TIMEOUT,
  );

  it("fails before installing when bun is present without Node.js", async () => {
    const { home, dir } = makeCase("sh-bun-no-node");
    const fakeBin = path.join(dir, "bin");
    const bunCalled = path.join(dir, "bun-called");
    writeExecutable(
      path.join(fakeBin, "bun"),
      [
        "#!/bin/sh",
        "printf '%s\\n' called >\"${FAKE_BUN_CALLED}\"",
        "exit 0",
      ].join("\n"),
    );

    const result = await run("/bin/sh", [installScript], {
      cwd: dir,
      env: baseEnv(home, {
        PATH: fakeBin,
        PICKFORGE_INSTALL_FROM_TARBALL: tarball,
        FAKE_BUN_CALLED: bunCalled,
      }),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Pickforge needs Node.js ^20.19, ^22.12, or >=23");
    expect(result.stderr).toContain("Install a supported Node.js version");
    expect(result.stdout).not.toContain("Installing");
    expect(fs.existsSync(bunCalled)).toBe(false);
  });

  it.each(["20.18.9", "21.9.0", "22.11.9"])(
    "rejects unsupported Node.js %s before installing",
    async (version) => {
      const { home, dir } = makeCase(`sh-node-reject-${version}`);
      const fakeBin = path.join(dir, "bin");
      const bunCalled = path.join(dir, "bun-called");
      writeExecutable(
        path.join(fakeBin, "node"),
        ["#!/bin/sh", `printf '%s\\n' v${version}`].join("\n"),
      );
      writeExecutable(
        path.join(fakeBin, "bun"),
        [
          "#!/bin/sh",
          "printf '%s\\n' called >\"${FAKE_BUN_CALLED}\"",
          "exit 0",
        ].join("\n"),
      );
      const result = await run("/bin/sh", [installScript], {
        cwd: dir,
        env: baseEnv(home, {
          PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
          PICKFORGE_INSTALL_FROM_TARBALL: tarball,
          FAKE_BUN_CALLED: bunCalled,
        }),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `Pickforge needs Node.js ^20.19, ^22.12, or >=23 (found v${version})`,
      );
      expect(fs.existsSync(bunCalled)).toBe(false);
    },
  );

  it.each(["20.19.0", "22.12.0", "23.0.0"])(
    "accepts the supported Node.js boundary %s",
    async (version) => {
      const { home, dir } = makeCase(`sh-node-accept-${version}`);
      const fakeBin = path.join(dir, "bin");
      writeExecutable(
        path.join(fakeBin, "node"),
        ["#!/bin/sh", `printf '%s\\n' v${version}`].join("\n"),
      );
      const result = await run("/bin/sh", [installScript], {
        cwd: dir,
        env: baseEnv(home, {
          PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
          PICKFORGE_INSTALL_FROM_TARBALL: tarball,
          PICKFORGE_INSTALL_RUNTIME: "invalid",
        }),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'unsupported PICKFORGE_INSTALL_RUNTIME "invalid"',
      );
      expect(result.stderr).not.toContain("Pickforge needs Node.js");
    },
  );

  it("uses bun pm bin -g to verify installs in a custom global bin dir", async () => {
    const { home, dir } = makeCase("sh-bun-custom-bin");
    const fakeBin = path.join(dir, "bin");
    const customBin = path.join(dir, "custom-bin");
    const bunInstall = path.join(dir, "fallback-bun");
    const bunLog = path.join(dir, "bun.log");
    writeExecutable(
      path.join(fakeBin, "node"),
      ["#!/bin/sh", "printf '%s\\n' v20.19.0"].join("\n"),
    );
    writeExecutable(
      path.join(fakeBin, "bun"),
      [
        "#!/bin/sh",
        "set -eu",
        "printf '%s\\n' \"$*\" >>\"${FAKE_BUN_LOG}\"",
        "if [ \"${1:-}\" = \"pm\" ] && [ \"${2:-}\" = \"bin\" ] && [ \"${3:-}\" = \"-g\" ]; then",
        "  printf '  %s  \\n' \"${FAKE_BUN_GLOBAL_BIN}\"",
        "  exit 0",
        "fi",
        "if [ \"${1:-}\" = \"add\" ] && [ \"${2:-}\" = \"--global\" ]; then",
        "  mkdir -p \"${FAKE_BUN_GLOBAL_BIN}\"",
        "  cat >\"${FAKE_BUN_GLOBAL_BIN}/pickforge-lab\" <<'PICKFORGE_FAKE_BIN'",
        "#!/bin/sh",
        "if [ \"${1:-}\" = \"--version\" ]; then",
        "  printf '%s\\n' \"${FAKE_PICKFORGE_VERSION}\"",
        "  exit 0",
        "fi",
        "exit 1",
        "PICKFORGE_FAKE_BIN",
        "  chmod +x \"${FAKE_BUN_GLOBAL_BIN}/pickforge-lab\"",
        "  cp \"${FAKE_BUN_GLOBAL_BIN}/pickforge-lab\" \"${FAKE_BUN_GLOBAL_BIN}/pickforge-mcp\"",
        "  exit 0",
        "fi",
        "exit 64",
      ].join("\n"),
    );

    const result = await run("/bin/sh", [installScript], {
      cwd: dir,
      env: baseEnv(home, {
        PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
        PICKFORGE_INSTALL_FROM_TARBALL: tarball,
        PICKFORGE_INSTALL_RUNTIME: "bun",
        BUN_INSTALL: bunInstall,
        FAKE_BUN_GLOBAL_BIN: customBin,
        FAKE_BUN_LOG: bunLog,
        FAKE_PICKFORGE_VERSION: cliVersion,
      }),
    });

    expect(result.code, describeFailure(result)).toBe(0);
    expect(result.stdout).toContain(
      `pickforge-lab ${cliVersion} and pickforge-mcp installed.`,
    );
    expect(result.stdout).toContain(`note: ${customBin} is not on your PATH`);
    expect(fs.existsSync(path.join(customBin, "pickforge-lab"))).toBe(true);
    expect(fs.existsSync(path.join(bunInstall, "bin", "pickforge-lab"))).toBe(false);
    const log = fs.readFileSync(bunLog, "utf8");
    expect(log).toContain(`add --global ${tarball}`);
    expect(log).toContain("pm bin -g");
  });

  it.runIf(hasBun())(
    "installs from a tarball with bun into an isolated BUN_INSTALL",
    async () => {
      const { home, dir } = makeCase("sh-bun");
      const bunInstall = path.join(dir, "bun");
      const env = baseEnv(home, {
        PICKFORGE_INSTALL_FROM_TARBALL: tarball,
        PICKFORGE_INSTALL_RUNTIME: "bun",
        BUN_INSTALL: bunInstall,
      });
      const result = await run("sh", [installScript], { cwd: dir, env });
      expect(result.code, describeFailure(result)).toBe(0);
      expect(result.stdout).toContain(
        `pickforge-lab ${cliVersion} and pickforge-mcp installed.`,
      );

      const version = await run(
        path.join(bunInstall, "bin", "pickforge-lab"),
        ["--version"],
        { env: baseEnv(home) },
      );
      expect(version.code, describeFailure(version)).toBe(0);
      expect(version.stdout.trim()).toBe(cliVersion);
    },
    NETWORK_TIMEOUT,
  );

  it("fails closed when the tarball override points nowhere", async () => {
    const { home, dir } = makeCase("sh-missing-tarball");
    const result = await run("sh", [installScript], {
      cwd: dir,
      env: baseEnv(home, {
        PICKFORGE_INSTALL_FROM_TARBALL: path.join(dir, "nope.tgz"),
      }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing file");
  });

  it("falls back to the deprecated tarball variable with a warning", async () => {
    const { home, dir } = makeCase("sh-legacy-tarball");
    const result = await run("sh", [installScript], {
      cwd: dir,
      env: baseEnv(home, {
        PICKLAB_INSTALL_FROM_TARBALL: path.join(dir, "nope.tgz"),
      }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "warning: PICKLAB_INSTALL_FROM_TARBALL is deprecated; use PICKFORGE_INSTALL_FROM_TARBALL instead",
    );
    expect(result.stderr.match(/PICKLAB_INSTALL_FROM_TARBALL is deprecated/g)).toHaveLength(1);
  });

  it("fails closed for an unsupported runtime override", async () => {
    const { home, dir } = makeCase("sh-bad-runtime");
    const result = await run("sh", [installScript], {
      cwd: dir,
      env: baseEnv(home, {
        PICKFORGE_INSTALL_FROM_TARBALL: tarball,
        PICKFORGE_INSTALL_RUNTIME: "yarn",
      }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unsupported");
  });

  it("falls back to the deprecated runtime variable with a warning", async () => {
    const { home, dir } = makeCase("sh-legacy-runtime");
    const result = await run("sh", [installScript], {
      cwd: dir,
      env: baseEnv(home, {
        PICKFORGE_INSTALL_FROM_TARBALL: tarball,
        PICKLAB_INSTALL_RUNTIME: "yarn",
      }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "warning: PICKLAB_INSTALL_RUNTIME is deprecated; use PICKFORGE_INSTALL_RUNTIME instead",
    );
    expect(result.stderr.match(/PICKLAB_INSTALL_RUNTIME is deprecated/g)).toHaveLength(1);
  });
});

describe("packed tarball execution", () => {
  it(
    "runs pickforge-lab via npm exec from the tarball (npx equivalent)",
    async () => {
      const { home, dir } = makeCase("npx");
      const result = await run(
        "npm",
        ["exec", "--yes", `--package=${tarball}`, "--", "pickforge-lab", "--version"],
        { cwd: dir, env: baseEnv(home) },
      );
      expect(result.code, describeFailure(result)).toBe(0);
      expect(result.stdout.trim()).toContain(cliVersion);
    },
    NETWORK_TIMEOUT,
  );

  it(
    "runs pickforge-lab init via npm exec from the tarball (npx package form)",
    async () => {
      const { home, dir } = makeCase("npx-init");
      const project = path.join(dir, "project");
      fs.mkdirSync(project, { recursive: true });
      const result = await run(
        "npm",
        [
          "exec",
          "--yes",
          `--package=${tarball}`,
          "--",
          "pickforge-lab",
          "init",
          "--profile",
          "generic",
          "--yes",
          "--json",
        ],
        { cwd: project, env: baseEnv(home) },
      );
      expect(result.code, describeFailure(result)).toBe(0);
      const report = JSON.parse(result.stdout) as Record<string, any>;
      expect(report.ok).toBe(true);
      expect(fs.existsSync(path.join(home, ".pickforge", "lab"))).toBe(true);
      expect(
        fs.existsSync(path.join(project, ".picklab", "config.json")),
      ).toBe(true);
    },
    NETWORK_TIMEOUT,
  );

  it.runIf(hasBun())(
    "installs the tarball with bun and runs both bins (bunx substitution: proves bun compatibility of the package)",
    async () => {
      const { home, dir } = makeCase("bun-project");
      const project = path.join(dir, "project");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(
        path.join(project, "package.json"),
        JSON.stringify({ name: "pickforge-lab-bun-host", private: true }),
      );
      const env = baseEnv(home, { BUN_INSTALL: path.join(dir, "bun") });
      const added = await run("bun", ["add", tarball], { cwd: project, env });
      expect(added.code, describeFailure(added)).toBe(0);

      const pickforgeLab = await run(
        path.join(project, "node_modules", ".bin", "pickforge-lab"),
        ["--version"],
        { cwd: project, env },
      );
      expect(pickforgeLab.code, describeFailure(pickforgeLab)).toBe(0);
      expect(pickforgeLab.stdout.trim()).toBe(cliVersion);

      const mcpBin = path.join(project, "node_modules", ".bin", "pickforge-mcp");
      expect(fs.existsSync(mcpBin)).toBe(true);
    },
    NETWORK_TIMEOUT,
  );
});
