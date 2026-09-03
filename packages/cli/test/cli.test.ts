import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const cliPath = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
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

function parseJson(result: CliResult): Record<string, any> {
  try {
    return JSON.parse(result.stdout) as Record<string, any>;
  } catch (error) {
    throw new Error(
      `CLI did not print JSON (${(error as Error).message}); ` +
        `stdout: ${result.stdout}; stderr: ${result.stderr}`,
    );
  }
}

function writeScript(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

interface FakeSdkOptions {
  images?: string[];
  avdNames?: string[];
}

function makeFakeSdk(root: string, opts: FakeSdkOptions = {}): string {
  const bin = path.join(root, "cmdline-tools", "latest", "bin");
  writeScript(path.join(bin, "sdkmanager"), "exit 0");
  writeScript(
    path.join(bin, "avdmanager"),
    `printf '%s\\n' "$*" >> ${path.join(root, "avdmanager.log")}\nexit 0`,
  );
  const avdLines = (opts.avdNames ?? [])
    .map((name) => `echo ${name}`)
    .join("\n");
  writeScript(
    path.join(root, "emulator", "emulator"),
    avdLines === "" ? "exit 0" : avdLines,
  );
  writeScript(path.join(root, "platform-tools", "adb"), "exit 0");
  for (const image of opts.images ?? []) {
    const [, api, tag, abi] = image.split(";") as [
      string,
      string,
      string,
      string,
    ];
    fs.mkdirSync(path.join(root, "system-images", api, tag, abi), {
      recursive: true,
    });
  }
  return root;
}

interface FakeEnvOptions {
  bins?: Record<string, string>;
  sdk?: string;
  /** Stand in for a real graphical session + resolvable askpass helper
   * (locked v1 contract) so privileged steps materialize into `sudo -A`
   * instead of failing preflight. PickLab never ships its own helper, so
   * tests that need one point SUDO_ASKPASS at a fake executable — none of
   * the fake `sudo` stand-ins below actually invoke it. */
  graphicalSudo?: boolean;
}

function makeEnv(
  tmp: string,
  opts: FakeEnvOptions = {},
): Record<string, string> {
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(opts.bins ?? {})) {
    writeScript(path.join(bin, name), body);
  }
  const env: Record<string, string> = {
    HOME: home,
    PICKLAB_HOME: path.join(home, ".picklab"),
    PATH: bin,
    PICKLAB_KVM_PATH: path.join(tmp, "no-kvm"),
  };
  if (opts.sdk !== undefined) {
    env.ANDROID_HOME = opts.sdk;
  }
  if (opts.graphicalSudo === true) {
    const helper = path.join(bin, "fake-askpass");
    writeScript(helper, "exit 0");
    env.DISPLAY = ":0";
    env.SUDO_ASKPASS = helper;
  }
  return env;
}

const IMAGE = "system-images;android-34;google_apis;x86_64";

let tmpDir: string;

beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-cli-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pickforge-lab doctor", () => {
  it("exits 0 with findings on a bare machine", async () => {
    const env = makeEnv(tmpDir);
    const result = await runCli(["doctor", "--json"], env, tmpDir);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(false);
    const byId = Object.fromEntries(
      (report.checks as Array<{ id: string; status: string }>).map((c) => [
        c.id,
        c.status,
      ]),
    );
    expect(byId["pickforge-home"]).toBe("missing");
    expect(byId["xvfb"]).toBe("missing");
    expect(byId["android-sdk"]).toBe("missing");
    expect(byId["x11vnc"]).toBe("warn");
    expect(byId["kvm"]).toBe("warn");
    expect(byId["lab-user"]).toBe("warn");
  });

  it("exits 0 when the only non-ok finding is the optional lab user", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), {
      images: [IMAGE],
      avdNames: ["pickforge-avd"],
    });
    const env = makeEnv(tmpDir, {
      sdk,
      bins: {
        Xvfb: "exit 0",
        xdotool: "exit 0",
        import: "exit 0",
        x11vnc: "exit 0",
      },
    });
    fs.mkdirSync(env.PICKLAB_HOME!, { recursive: true });
    const kvmPath = path.join(tmpDir, "kvm");
    fs.writeFileSync(kvmPath, "", { mode: 0o660 });
    env.PICKLAB_KVM_PATH = kvmPath;

    const result = await runCli(["doctor", "--json"], env, tmpDir);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    const nonOk = (
      report.checks as Array<{ id: string; status: string }>
    )
      .filter((check) => check.status !== "ok")
      .map((check) => ({ id: check.id, status: check.status }));
    expect(nonOk).toEqual([{ id: "lab-user", status: "warn" }]);
  });

  it("creates the pickforge-lab home with --fix and skips privileged repairs", async () => {
    const env = makeEnv(tmpDir);
    const result = await runCli(["doctor", "--json", "--fix"], env, tmpDir);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.fix.status).toBe("completed");
    expect(fs.statSync(env.PICKLAB_HOME!).isDirectory()).toBe(true);
    expect(report.fix.results).toEqual([
      { id: "pickforge-home", ok: true, detail: expect.stringContaining("mkdir") },
    ]);
    const skipped = (report.fix.skipped as string[]).join("\n");
    expect(skipped).toContain("avd:");
    expect(skipped).toContain("lab-user:");
    expect(skipped).toContain(
      'sudo not found on PATH; cannot provision lab user "pickforge-lab". ' +
        "Install sudo, or create the user manually as root: " +
        "useradd -r -M -s /usr/sbin/nologin pickforge-lab",
    );
    expect((report.fix.skipped as string[]).map((entry) => entry.split(":")[0]))
      .toEqual(["avd", "lab-user"]);
  });

  it("keeps the 'lab-user: ' skip prefix when the failure is askpass-unavailable rather than sudo-missing", async () => {
    // sudo IS on PATH here (unlike the test above), so the lab-user section
    // fails preflight on the askpass capability check instead — its skip
    // reason must still carry the same "lab-user: " context its "avd: "
    // sibling does (P3 fix: prepareSections previously dropped it for this
    // failure mode).
    const env = makeEnv(tmpDir, { bins: { sudo: "exit 0" } });
    const result = await runCli(["doctor", "--json", "--fix"], env, tmpDir);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.fix.status).toBe("completed");
    const skipped = (report.fix.skipped as string[]).join("\n");
    expect(skipped).toContain("avd:");
    expect(skipped).toMatch(/lab-user: (No graphical session detected|Graphical sudo prompts are only supported on Linux)/);
    expect((report.fix.skipped as string[]).map((entry) => entry.split(":")[0]))
      .toEqual(["avd", "lab-user"]);
  });

  it("skips AVD creation under --fix without consent in a non-interactive session", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const result = await runCli(["doctor", "--json", "--fix"], env, tmpDir);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(fs.existsSync(path.join(sdk, "avdmanager.log"))).toBe(false);
    expect(fs.statSync(env.PICKLAB_HOME!).isDirectory()).toBe(true);
    const skipped = (report.fix.skipped as string[]).join("\n");
    expect(skipped).toContain("avd: skipped (requires consent");
    expect(skipped).toContain("--yes");
    expect((report.fix.skipped as string[]).map((entry) => entry.split(":")[0]))
      .toEqual(["avd", "lab-user"]);
    expect(
      (report.fix.steps as Array<{ id: string }>).map((step) => step.id),
    ).not.toContain("create-avd");
  });

  it("creates the AVD under --fix when consent is given via --yes", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const result = await runCli(
      ["doctor", "--json", "--fix", "--yes"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    const log = fs.readFileSync(path.join(sdk, "avdmanager.log"), "utf8");
    expect(log.trim()).toBe(`create avd -n pickforge-avd -k ${IMAGE}`);
    expect((report.fix.skipped as string[]).join("\n")).not.toContain("avd:");
  });

  it("prints the repair plan without applying it under --fix --dry-run", async () => {
    const env = makeEnv(tmpDir);
    const result = await runCli(
      ["doctor", "--json", "--fix", "--dry-run"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.fix.dryRun).toBe(true);
    expect(
      (report.fix.steps as Array<{ id: string }>).map((step) => step.id),
    ).toEqual(["pickforge-home"]);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });
});

describe("pickforge-lab init", () => {
  it("writes the project config for the generic profile", async () => {
    const env = makeEnv(tmpDir);
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "generic", "--json"],
      env,
      projectDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    expect(report.status).toBe("completed");
    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".picklab", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config).toEqual({ profile: "generic" });
    expect(fs.statSync(env.PICKLAB_HOME!).isDirectory()).toBe(true);
  });

  it("does not write anything in --dry-run", async () => {
    const env = makeEnv(tmpDir);
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "generic", "--dry-run", "--json"],
      env,
      projectDir,
    );
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });

  // Graphical sudo is Linux-only (locked v1 contract) — on any other
  // platform the askpass preflight check always fails first, before the
  // consent gate under test here even runs. Runs on Linux CI; skips
  // harmlessly elsewhere (see also "pickforge-lab setup lab-user" below).
  it.skipIf(process.platform !== "linux")(
    "fails closed when --create-lab-user lacks --yes in a non-interactive session",
    async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const env = makeEnv(tmpDir, {
      graphicalSudo: true,
      bins: { sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0` },
    });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "generic", "--create-lab-user", "--json"],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.ok).toBe(false);
    expect(report.status).toBe("cancelled");
    expect((report.errors as string[]).join("\n")).toContain("--yes");
    expect(fs.existsSync(sudoLog)).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });

  it("fails closed when --create-avd lacks --yes in a non-interactive session", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "generic", "--create-avd", "--json"],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect((report.errors as string[]).join("\n")).toContain("--yes");
    expect(fs.existsSync(path.join(sdk, "avdmanager.log"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });

  it("reports required AVD consent refusal before the required-check error", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "android", "--create-avd", "--json"],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.errors).toHaveLength(2);
    expect(report.errors[0]).toContain("without consent");
    expect(report.errors[1]).toContain('Required check "avd" failed');
    expect(report.plan.map((step: { id: string }) => step.id)).toEqual([
      "project-config",
      "pickforge-home",
    ]);
  });

  it("initializes flutter-desktop without planning lab-user sudo steps", async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const env = makeEnv(tmpDir, {
      bins: {
        Xvfb: "exit 0",
        xdotool: "exit 0",
        import: "exit 0",
        sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0`,
      },
    });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);

    const result = await runCli(
      ["init", "--profile", "flutter-desktop", "--yes", "--json"],
      env,
      projectDir,
    );

    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    expect((report.checks as Array<{ id: string }>).map((check) => check.id))
      .not.toContain("lab-user");
    expect((report.plan as Array<{ id: string }>).map((step) => step.id)).toEqual(
      ["project-config", "pickforge-home"],
    );
    expect(fs.existsSync(sudoLog)).toBe(false);
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "plans lab-user sudo steps for desktop+android with explicit consent",
    async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), {
      images: [IMAGE],
      avdNames: ["pickforge-avd"],
    });
    const env = makeEnv(tmpDir, {
      sdk,
      graphicalSudo: true,
      bins: {
        Xvfb: "exit 0",
        xdotool: "exit 0",
        import: "exit 0",
        sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0`,
      },
    });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);

    const result = await runCli(
      [
        "init",
        "--profile",
        "desktop+android",
        "--yes",
        "--create-lab-user",
        "--dry-run",
        "--json",
      ],
      env,
      projectDir,
    );

    expect(result.code).toBe(0);
    const report = parseJson(result);
    const plan = report.plan as Array<any>;
    expect(plan.map((step) => step.id)).toEqual([
      "project-config",
      "pickforge-home",
      "useradd",
      "mkdir-home",
      "chown-home",
      "chmod-home",
      "persist-lab-user",
    ]);
    expect(plan.find((step) => step.id === "useradd").command.args).toEqual([
      "-A",
      "useradd",
      "-r",
      "-M",
      "-s",
      "/usr/sbin/nologin",
      "pickforge-lab",
    ]);
    expect(fs.existsSync(sudoLog)).toBe(false);
  });

  it("prints the check snapshot before executor logs in non-JSON mode", async () => {
    const env = makeEnv(tmpDir);
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "generic"],
      env,
      projectDir,
    );
    expect(result.code).toBe(0);
    const checkIndex = result.stdout.indexOf("pickforge-home");
    const doneIndex = result.stdout.indexOf("[done]");
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(checkIndex);
  });

  it("fails closed with the exact sdkmanager command when system images are missing", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"));
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "android", "--yes", "--create-avd", "--json"],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.ok).toBe(false);
    expect(report.status).toBe("failed");
    expect((report.errors as string[]).join("\n")).toContain(
      'sdkmanager "system-images;android-35;google_apis;x86_64"',
    );
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });

  it("prints a recovery hint when init fails after writing project config", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    writeScript(
      path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
      "echo avdmanager boom >&2\nexit 7",
    );
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);

    const result = await runCli(
      ["init", "--profile", "android", "--yes", "--create-avd", "--json"],
      env,
      projectDir,
    );

    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect((report.errors as string[]).join("\n")).toContain(
      "Project config was written",
    );
    expect((report.errors as string[]).join("\n")).toContain("pickforge-lab init");
    expect((report.errors as string[]).join("\n")).toContain("pickforge-lab doctor");
    expect(
      fs.existsSync(path.join(projectDir, ".picklab", "config.json")),
    ).toBe(true);
  });

  it("fails closed without side effects when sudo is unavailable", async () => {
    const env = makeEnv(tmpDir, {
      bins: { Xvfb: "exit 0", xdotool: "exit 0", import: "exit 0" },
    });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      [
        "init",
        "--profile",
        "flutter-desktop",
        "--yes",
        "--create-lab-user",
        "--json",
      ],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.status).toBe("failed");
    expect((report.errors as string[]).join("\n")).toContain("sudo not found");
    expect((report.plan as Array<{ id: string }>).map((step) => step.id)).toEqual(
      ["project-config", "pickforge-home"],
    );
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });

  it("fails closed with an actionable manual fallback when sudo exists but no graphical session is available", async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const env = makeEnv(tmpDir, {
      bins: { sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0` },
    });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      [
        "init",
        "--profile",
        "generic",
        "--yes",
        "--create-lab-user",
        "--json",
      ],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    const errors = (report.errors as string[]).join("\n");
    // Linux CI hits the "no graphical session" branch (this env sets no
    // DISPLAY/WAYLAND_DISPLAY); any other dev platform hits the always-Linux
    // -only branch first (locked v1 contract scope) — both name the same
    // manual fallback, which is what this test actually verifies end to end.
    expect(errors).toContain(
      process.platform === "linux"
        ? "No graphical session detected"
        : "only supported on Linux",
    );
    expect(errors).toContain(
      "Run it yourself in a terminal: sudo useradd -r -M -s /usr/sbin/nologin pickforge-lab",
    );
    expect(fs.existsSync(sudoLog)).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
  });

  it("retains earlier AVD sections when later lab-user privilege is unavailable", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      [
        "init",
        "--profile",
        "generic",
        "--create-avd",
        "--create-lab-user",
        "--yes",
        "--json",
      ],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.plan.map((step: { id: string }) => step.id)).toEqual([
      "project-config",
      "pickforge-home",
      "create-avd",
      "persist-avd",
    ]);
    expect(report.errors.join("\n")).toContain("sudo not found");
    expect(fs.existsSync(path.join(sdk, "avdmanager.log"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });

  it("reports an unrelated planning error and missing privilege support", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"));
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      [
        "init",
        "--profile",
        "generic",
        "--create-avd",
        "--create-lab-user",
        "--yes",
        "--json",
      ],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.errors[0]).toContain("sdkmanager");
    expect(report.errors[1]).toContain("sudo not found");
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
    expect(fs.existsSync(env.PICKLAB_HOME!)).toBe(false);
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "materializes selected sudo steps even when another section blocks execution",
    async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"));
    const env = makeEnv(tmpDir, {
      sdk,
      graphicalSudo: true,
      bins: { sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0` },
    });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      [
        "init",
        "--profile",
        "generic",
        "--create-avd",
        "--create-lab-user",
        "--yes",
        "--json",
      ],
      env,
      projectDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    const useradd = report.plan.find(
      (step: { id: string }) => step.id === "useradd",
    );
    expect(useradd.command.args.slice(0, 2)).toEqual(["-A", "useradd"]);
    expect(fs.existsSync(sudoLog)).toBe(false);
  });

  it("prints the full provisioning plan under --dry-run for android", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      [
        "init",
        "--profile",
        "android",
        "--yes",
        "--create-avd",
        "--dry-run",
        "--json",
      ],
      env,
      projectDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    const ids = (report.plan as Array<{ id: string }>).map((step) => step.id);
    expect(ids).toEqual([
      "project-config",
      "pickforge-home",
      "create-avd",
      "persist-avd",
    ]);
    const createAvd = (report.plan as Array<any>).find(
      (step) => step.id === "create-avd",
    );
    expect(createAvd.command.args).toEqual([
      "create",
      "avd",
      "-n",
      "pickforge-avd",
      "-k",
      IMAGE,
    ]);
    expect(fs.existsSync(path.join(sdk, "avdmanager.log"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".picklab"))).toBe(false);
  });

  it("provisions the AVD via avdmanager and persists configs", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    const result = await runCli(
      ["init", "--profile", "android", "--yes", "--create-avd", "--json"],
      env,
      projectDir,
    );
    expect(result.code).toBe(0);
    const log = fs.readFileSync(path.join(sdk, "avdmanager.log"), "utf8");
    expect(log.trim()).toBe(`create avd -n pickforge-avd -k ${IMAGE}`);
    const projectConfig = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".picklab", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(projectConfig).toEqual({ profile: "android" });
    const globalConfig = JSON.parse(
      fs.readFileSync(path.join(env.PICKLAB_HOME!, "config.json"), "utf8"),
    ) as Record<string, any>;
    expect(globalConfig.android.avdName).toBe("pickforge-avd");
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "preserves unprivileged and privileged step order in one init",
    async () => {
    const sequenceLog = path.join(tmpDir, "sequence.log");
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    writeScript(
      path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
      `echo avdmanager >> ${sequenceLog}\nexit 0`,
    );
    const env = makeEnv(tmpDir, {
      sdk,
      graphicalSudo: true,
      bins: { sudo: `echo "sudo:$*" >> ${sequenceLog}\nexit 0` },
    });
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);

    const result = await runCli(
      [
        "init",
        "--profile",
        "generic",
        "--create-avd",
        "--create-lab-user",
        "--yes",
        "--json",
      ],
      env,
      projectDir,
    );

    expect(result.code).toBe(0);
    const sequence = fs.readFileSync(sequenceLog, "utf8").trim().split("\n");
    expect(sequence[0]).toBe("avdmanager");
    expect(sequence.slice(1).every((line) => line.startsWith("sudo:-A "))).toBe(
      true,
    );
  });
});

describe("pickforge-lab setup lab-user", () => {
  // Graphical sudo is Linux-only (locked v1 contract): resolveAskpassCapability
  // gates on process.platform before even looking at DISPLAY/SUDO_ASKPASS, so
  // any test that needs the "available" happy path to actually route a step
  // through sudo can only run for real on Linux. These skip harmlessly on
  // other dev platforms and run in full on Linux CI.
  it.skipIf(process.platform !== "linux")(
    "prints the provisioning plan in --dry-run without running sudo",
    async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const env = makeEnv(tmpDir, {
      graphicalSudo: true,
      bins: { sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0` },
    });
    const result = await runCli(
      ["setup", "lab-user", "--dry-run", "--yes", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    const ids = (report.plan as Array<{ id: string }>).map((step) => step.id);
    expect(ids).toEqual([
      "useradd",
      "mkdir-home",
      "chown-home",
      "chmod-home",
      "persist-lab-user",
    ]);
    expect((report.plan as Array<any>)[0].command.args).toEqual([
      "-A",
      "useradd",
      "-r",
      "-M",
      "-s",
      "/usr/sbin/nologin",
      "pickforge-lab",
    ]);
    expect(fs.existsSync(sudoLog)).toBe(false);
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "fails closed without --yes in a non-interactive session",
    async () => {
    const env = makeEnv(tmpDir, {
      graphicalSudo: true,
      bins: { sudo: "exit 0" },
    });
    const result = await runCli(["setup", "lab-user", "--json"], env, tmpDir);
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect((report.errors as string[]).join("\n")).toContain("--yes");
    expect((report.plan as Array<any>)[0].command.args).toEqual([
      "-A",
      "useradd",
      "-r",
      "-M",
      "-s",
      "/usr/sbin/nologin",
      "pickforge-lab",
    ]);
  });

  it("fails closed with an actionable manual fallback when no graphical session is available", async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const env = makeEnv(tmpDir, {
      bins: { sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0` },
    });
    const result = await runCli(
      ["setup", "lab-user", "--yes", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    const errors = (report.errors as string[]).join("\n");
    // See the equivalent "pickforge-lab init" test above for why this branches.
    expect(errors).toContain(
      process.platform === "linux"
        ? "No graphical session detected"
        : "only supported on Linux",
    );
    expect(errors).toContain(
      "Run it yourself in a terminal: sudo useradd -r -M -s /usr/sbin/nologin pickforge-lab",
    );
    expect(fs.existsSync(sudoLog)).toBe(false);
  });

  it("does not print the already-existing user before consent", async () => {
    const home = path.join(tmpDir, "missing-home");
    const env = makeEnv(tmpDir, {
      bins: {
        getent: "echo 'pickforge-lab:x:999:999::/var/empty:/bin/false'",
        sudo: "exit 0",
      },
    });
    const result = await runCli(
      ["setup", "lab-user", "--home", home],
      env,
      tmpDir,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('User "pickforge-lab" already exists.');
    expect(fs.existsSync(home)).toBe(false);
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "prints the already-existing user before approved dry-run logs",
    async () => {
    const home = path.join(tmpDir, "missing-home");
    const env = makeEnv(tmpDir, {
      graphicalSudo: true,
      bins: {
        getent: "echo 'pickforge-lab:x:999:999::/var/empty:/bin/false'",
        sudo: "exit 0",
      },
    });
    const result = await runCli(
      ["setup", "lab-user", "--home", home, "--yes", "--dry-run"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(0);
    const existsIndex = result.stdout.indexOf(
      'User "pickforge-lab" already exists.',
    );
    expect(existsIndex).toBeGreaterThanOrEqual(0);
    expect(result.stdout.indexOf("[dry-run]")).toBeGreaterThan(existsIndex);
    expect(fs.existsSync(home)).toBe(false);
  });

  it("fails closed when sudo is unavailable", async () => {
    const env = makeEnv(tmpDir);
    const result = await runCli(
      ["setup", "lab-user", "--yes", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.status).toBe("failed");
    expect((report.errors as string[]).join("\n")).toContain("sudo not found");
    expect(report.plan).toEqual([]);
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "runs each provisioning step through sudo and persists the config",
    async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const env = makeEnv(tmpDir, {
      graphicalSudo: true,
      bins: { sudo: `printf '%s\\n' "$*" >> ${sudoLog}\nexit 0` },
    });
    const result = await runCli(
      ["setup", "lab-user", "--yes", "--json", "--name", "pickforge-lab"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.status).toBe("completed");
    const lines = fs
      .readFileSync(sudoLog, "utf8")
      .trim()
      .split("\n");
    expect(lines).toEqual([
      "-A useradd -r -M -s /usr/sbin/nologin pickforge-lab",
      "-A mkdir -p /var/lib/pickforge/lab-home",
      "-A chown pickforge-lab:pickforge-lab /var/lib/pickforge/lab-home",
      "-A chmod 750 /var/lib/pickforge/lab-home",
    ]);
    const globalConfig = JSON.parse(
      fs.readFileSync(path.join(env.PICKLAB_HOME!, "config.json"), "utf8"),
    ) as Record<string, any>;
    expect(globalConfig.labUser).toEqual({
      name: "pickforge-lab",
      home: "/var/lib/pickforge/lab-home",
    });
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "returns redacted partial results when a privileged step fails",
    async () => {
    const sudoLog = path.join(tmpDir, "sudo.log");
    const env = makeEnv(tmpDir, {
      graphicalSudo: true,
      bins: {
        sudo:
          `printf '%s\\n' "$*" >> ${sudoLog}\n` +
          `if [ "$2" = "chmod" ]; then ` +
          `echo 'API_TOKEN=planted-secret' >&2; exit 7; fi\nexit 0`,
      },
    });
    const result = await runCli(
      ["setup", "lab-user", "--yes", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    // This step fails without a "sudo:"-prefixed diagnostic, so it's a
    // generic step failure, not a sudo cancellation/denial.
    expect(report.status).toBe("failed");
    expect(
      (report.results as Array<{ id: string; ok: boolean }>).map((step) => [
        step.id,
        step.ok,
      ]),
    ).toEqual([
      ["useradd", true],
      ["mkdir-home", true],
      ["chown-home", true],
      ["chmod-home", false],
    ]);
    expect(JSON.stringify(report)).toContain("API_TOKEN=[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("planted-secret");
    expect(fs.existsSync(path.join(env.PICKLAB_HOME!, "config.json"))).toBe(
      false,
    );
  });

  // Linux-only (see rationale above).
  it.skipIf(process.platform !== "linux")(
    "reports status: cancelled, distinct from failed/declined, when sudo denies or cancels a step",
    async () => {
    const env = makeEnv(tmpDir, {
      graphicalSudo: true,
      bins: {
        sudo: 'echo "sudo: a password is required" >&2\nexit 1',
      },
    });
    const result = await runCli(
      ["setup", "lab-user", "--yes", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.status).toBe("cancelled");
    expect((report.errors as string[]).join("\n")).toContain(
      "sudo denied or cancelled",
    );
  });
});

describe("pickforge-lab setup android", () => {
  it("reports the detected toolchain without --create-avd", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const result = await runCli(["setup", "android", "--json"], env, tmpDir);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.sdkRoot).toBe(sdk);
    expect(report.tools.avdmanager).toBe(
      path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
    );
    expect(report.systemImages).toEqual([IMAGE]);
    expect(report.avdExists).toBe(false);
    expect(report.plan).toEqual([]);
  });

  it("fails closed with the exact sdkmanager command when the image is missing", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const result = await runCli(
      [
        "setup",
        "android",
        "--create-avd",
        "--yes",
        "--json",
        "--system-image",
        "system-images;android-36;google_apis;x86_64",
      ],
      env,
      tmpDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect((report.errors as string[]).join("\n")).toContain(
      'sdkmanager "system-images;android-36;google_apis;x86_64"',
    );
  });

  it("prints the creation plan in --dry-run without invoking avdmanager", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const result = await runCli(
      ["setup", "android", "--create-avd", "--dry-run", "--yes", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(
      (report.plan as Array<{ id: string }>).map((step) => step.id),
    ).toEqual(["create-avd", "persist-avd"]);
    expect(fs.existsSync(path.join(sdk, "avdmanager.log"))).toBe(false);
  });

  it("fails closed without --yes in a non-interactive session", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), { images: [IMAGE] });
    const env = makeEnv(tmpDir, { sdk });
    const result = await runCli(
      ["setup", "android", "--create-avd", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect((report.errors as string[]).join("\n")).toContain("--yes");
  });

  it("is a no-op (config persistence only) when the AVD already exists", async () => {
    const sdk = makeFakeSdk(path.join(tmpDir, "sdk"), {
      images: [IMAGE],
      avdNames: ["pickforge-avd"],
    });
    const env = makeEnv(tmpDir, { sdk });
    const result = await runCli(
      ["setup", "android", "--create-avd", "--yes", "--json"],
      env,
      tmpDir,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.avdExists).toBe(true);
    expect(
      (report.plan as Array<{ id: string }>).map((step) => step.id),
    ).toEqual(["persist-avd"]);
    expect(fs.existsSync(path.join(sdk, "avdmanager.log"))).toBe(false);
  });
});
