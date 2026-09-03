import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AskpassCapability } from "../src/provision/askpass.js";
import {
  classifyPlan,
  createLocalExecutionAdapter,
  executeProvisioning,
  PrivilegedCommandDeniedError,
  type ProvisioningExecutionAdapter,
  type ProvisioningSection,
} from "../src/provision/executor.js";
import type { ProvisioningPlan, ProvisioningStep } from "../src/provision/plan.js";

const AVAILABLE_ASKPASS: AskpassCapability = {
  state: "available",
  helper: "/usr/bin/ksshaskpass",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-executor-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function command(
  id: string,
  privileged = false,
  args: string[] = ["-e", "process.exit(0)"],
): ProvisioningStep {
  return {
    id,
    title: id,
    kind: "command",
    privileged,
    command: { cmd: process.execPath, args },
  };
}

function approved(plan: ProvisioningPlan): ProvisioningSection {
  return {
    kind: "plan",
    plan,
    consent: { decide: async () => ({ kind: "approved" }) },
  };
}

describe("classifyPlan", () => {
  it("classifies empty, automatic, unprivileged, privileged, and mixed plans", () => {
    expect(classifyPlan({ steps: [] })).toBe("empty");
    expect(
      classifyPlan({
        steps: [
          {
            id: "config",
            title: "config",
            kind: "write-global-config",
            privileged: false,
            config: { profile: "generic" },
          },
        ],
      }),
    ).toBe("automatic");
    expect(classifyPlan({ steps: [command("normal")] })).toBe("unprivileged");
    expect(classifyPlan({ steps: [command("root", true)] })).toBe("privileged");
    expect(
      classifyPlan({ steps: [command("normal"), command("root", true)] }),
    ).toBe("mixed");
  });
});

describe("executeProvisioning", () => {
  it("only logs redacted plan details in dry-run mode", async () => {
    const target = path.join(tmpDir, "home", "state");
    const lines: string[] = [];
    let adapterCalls = 0;
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: {
            steps: [
              {
                id: "pickforge-home",
                title: "Create Pickforge home",
                kind: "mkdir",
                privileged: false,
                dir: target,
              },
              command("secret", true, ["--token=planted-secret"]),
            ],
          },
        },
      ],
      {
        dryRun: true,
        log: (line) => lines.push(line),
        adapter: {
          materialize: (step) => step,
          execute: async () => {
            adapterCalls += 1;
          },
          executePrivileged: async () => {
            adapterCalls += 1;
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.results.map((step) => step.detail)).toEqual([
      "dry-run",
      "dry-run",
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`mkdir -p ${target}`);
    expect(lines.join("\n")).toContain("--token=[REDACTED]");
    expect(lines.join("\n")).not.toContain("planted-secret");
    expect(adapterCalls).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "home"))).toBe(false);
  });

  it("fails closed before mutation when command consent is absent", async () => {
    const target = path.join(tmpDir, "should-not-exist");
    const result = await executeProvisioning([
      {
        kind: "plan",
        plan: {
          steps: [
            {
              id: "mk",
              title: "mk",
              kind: "mkdir",
              privileged: false,
              dir: target,
            },
          ],
        },
      },
      { kind: "plan", plan: { steps: [command("needs-consent")] } },
    ]);
    expect(result.status).toBe("cancelled");
    expect(result.results).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("preflights cancellation before earlier automatic steps mutate", async () => {
    const target = path.join(tmpDir, "should-not-exist");
    const result = await executeProvisioning([
      {
        kind: "plan",
        plan: {
          steps: [
            {
              id: "mk",
              title: "mk",
              kind: "mkdir",
              privileged: false,
              dir: target,
            },
          ],
        },
      },
      {
        kind: "plan",
        plan: { steps: [command("declined")] },
        consent: {
          decide: async () => ({
            kind: "declined",
            reason: "user declined",
          }),
        },
      },
    ]);
    expect(result.status).toBe("declined");
    expect(result.error).toBe("user declined");
    expect(result.plan.steps.map((step) => step.id)).toEqual(["mk"]);
    expect(result.results).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("skips declined sections and executes the remaining plan", async () => {
    const calls: string[] = [];
    const adapter: ProvisioningExecutionAdapter = {
      materialize: (step) => step,
      execute: async (step) => {
        calls.push(step.id);
      },
      executePrivileged: async (step) => {
        calls.push(step.id);
      },
    };
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: { steps: [command("skip")] },
          consent: {
            onDenied: "skip",
            decide: async () => ({ kind: "declined", reason: "skipped item" }),
          },
        },
        approved({ steps: [command("run")] }),
      ],
      { adapter },
    );
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(["skipped item"]);
    expect(result.plan.steps.map((step) => step.id)).toEqual(["run"]);
    expect(calls).toEqual(["run"]);
  });

  it("routes mixed plans sequentially according to step privilege", async () => {
    const calls: string[] = [];
    const classifications: string[] = [];
    const plan = {
      steps: [command("first"), command("root", true), command("last")],
    };
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan,
          consent: {
            decide: async (classification) => {
              classifications.push(classification);
              return { kind: "approved" };
            },
          },
        },
      ],
      {
        adapter: {
          materialize: (step) => step,
          execute: async (step) => {
            calls.push(`normal:${step.id}`);
          },
          executePrivileged: async (step) => {
            calls.push(`privileged:${step.id}`);
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(classifications).toEqual(["mixed"]);
    expect(calls).toEqual([
      "normal:first",
      "privileged:root",
      "normal:last",
    ]);
  });

  it("executes the exact materialized step through the selected route", async () => {
    const rawNormal = command("normal");
    const rawPrivileged = command("root", true);
    const materialized = new Map<ProvisioningStep, ProvisioningStep>();
    const routed: Array<{ route: string; step: ProvisioningStep }> = [];
    const adapter: ProvisioningExecutionAdapter = {
      materialize: (step) => {
        const value = {
          ...step,
          title: `${step.title}-materialized`,
        } as ProvisioningStep;
        materialized.set(step, value);
        return value;
      },
      execute: async (step) => {
        routed.push({ route: "normal", step });
      },
      executePrivileged: async (step) => {
        routed.push({ route: "privileged", step });
      },
    };

    await executeProvisioning(
      [approved({ steps: [rawNormal, rawPrivileged] })],
      { adapter },
    );

    expect(routed).toEqual([
      { route: "normal", step: materialized.get(rawNormal) },
      { route: "privileged", step: materialized.get(rawPrivileged) },
    ]);
  });

  it("stops on failure with redacted partial results", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const result = await executeProvisioning(
      [approved({ steps: [command("first"), command("root", true), command("last")] })],
      {
        log: (line) => lines.push(line),
        adapter: {
          materialize: (step) => step,
          execute: async (step) => {
            calls.push(step.id);
          },
          executePrivileged: async (step) => {
            calls.push(step.id);
            throw new Error("API_TOKEN=planted-secret");
          },
        },
      },
    );
    expect(result.status).toBe("failed");
    expect(result.results.map((step) => [step.id, step.ok])).toEqual([
      ["first", true],
      ["root", false],
    ]);
    expect(calls).toEqual(["first", "root"]);
    expect(result.error).toContain("API_TOKEN=[REDACTED]");
    expect(JSON.stringify(result) + lines.join("\n")).not.toContain(
      "planted-secret",
    );
  });

  it("returns the local sudo presentation when consent is declined", async () => {
    const raw: ProvisioningStep = {
      id: "useradd",
      title: "useradd",
      kind: "command",
      privileged: true,
      command: {
        cmd: "useradd",
        args: ["-r", "-M", "-s", "/usr/sbin/nologin", "pickforge-lab"],
      },
    };
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: { steps: [raw] },
          consent: {
            retainPlanOnDenied: true,
            decide: async () => ({ kind: "declined", reason: "declined" }),
          },
        },
      ],
      {
        privilege: { sudoPath: "/usr/bin/sudo", askpass: AVAILABLE_ASKPASS },
      },
    );
    expect(result.status).toBe("declined");
    expect(result.plan.steps[0]).toMatchObject({
      privileged: true,
      command: {
        cmd: "/usr/bin/sudo",
        args: [
          "-A",
          "useradd",
          "-r",
          "-M",
          "-s",
          "/usr/sbin/nologin",
          "pickforge-lab",
        ],
        env: { SUDO_ASKPASS: "/usr/bin/ksshaskpass" },
      },
    });
    expect(raw).toMatchObject({ command: { cmd: "useradd" } });
    if (raw.kind !== "command") throw new Error("expected command step");
    expect(raw.command.args).toEqual([
      "-r",
      "-M",
      "-s",
      "/usr/sbin/nologin",
      "pickforge-lab",
    ]);
  });

  it("fails privilege preflight before any mutation", async () => {
    const target = path.join(tmpDir, "should-not-exist");
    let consentCalls = 0;
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: {
            steps: [
              {
                id: "mk",
                title: "mk",
                kind: "mkdir",
                privileged: false,
                dir: target,
              },
            ],
          },
        },
        {
          kind: "plan",
          plan: { steps: [command("root", true)] },
          privilegeUnavailable: { reason: "same missing sudo message" },
          consent: {
            decide: async () => {
              consentCalls += 1;
              return { kind: "approved" };
            },
          },
        },
      ],
      { privilege: { sudoPath: null } },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("same missing sudo message");
    expect(result.plan.steps.map((step) => step.id)).toEqual(["mk"]);
    expect(result.results).toEqual([]);
    expect(consentCalls).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("retains prior prepared sections and ordered policy results", async () => {
    const target = path.join(tmpDir, "should-not-exist");
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: {
            steps: [
              {
                id: "mk",
                title: "mk",
                kind: "mkdir",
                privileged: false,
                dir: target,
              },
            ],
          },
        },
        { kind: "blocked", action: "skip", reason: "first skip" },
        {
          kind: "plan",
          plan: { steps: [command("root", true)] },
          privilegeUnavailable: { action: "skip", reason: "second skip" },
        },
        { kind: "blocked", reason: "later error" },
      ],
      { privilege: { sudoPath: null } },
    );

    expect(result.plan.steps.map((step) => step.id)).toEqual(["mk"]);
    expect(result.skipped).toEqual(["first skip", "second skip"]);
    expect(result.errors).toEqual(["later error"]);
    expect(result.results).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("redacts the entire public plan while routing unredacted materialized data", async () => {
    const secret = "API_TOKEN=planted-secret";
    const routed: ProvisioningStep[] = [];
    const lines: string[] = [];
    const raw: ProvisioningStep = {
      id: secret,
      title: secret,
      kind: "command",
      privileged: true,
      command: {
        cmd: "tool",
        args: [secret],
        env: { API_TOKEN: "planted-secret" },
        input: secret,
      },
    };
    const config: ProvisioningStep = {
      id: "config",
      title: "config",
      kind: "write-global-config",
      privileged: false,
      config: { labUser: { name: secret, home: secret } },
    };
    const result = await executeProvisioning(
      [approved({ steps: [raw, config] })],
      {
        log: (line) => lines.push(line),
        adapter: {
          materialize: (step) => step,
          execute: async (step) => {
            routed.push(step);
          },
          executePrivileged: async (step) => {
            routed.push(step);
          },
        },
      },
    );

    expect(routed).toEqual([raw, config]);
    expect(JSON.stringify(result.plan) + lines.join("\n")).not.toContain(
      "planted-secret",
    );
    expect(JSON.stringify(result.plan)).toContain("[REDACTED]");
  });

  it("merges global and project config through the local adapter", async () => {
    const home = path.join(tmpDir, "state");
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(projectDir);
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ profile: "android", android: { extra: true } }),
    );
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: {
            steps: [
              {
                id: "global",
                title: "global",
                kind: "write-global-config",
                privileged: false,
                config: { android: { avdName: "pickforge-avd" } },
              },
              {
                id: "project",
                title: "project",
                kind: "write-project-config",
                privileged: false,
                config: { profile: "generic" },
              },
            ],
          },
        },
      ],
      { env: { PICKFORGE_HOME: home }, projectDir },
    );
    expect(result.ok).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")),
    ).toEqual({
      profile: "android",
      android: { extra: true, avdName: "pickforge-avd" },
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(projectDir, ".picklab", "config.json"), "utf8"),
      ),
    ).toEqual({ profile: "generic" });
  });
});

// pickforge/pickforge#27 — "Shared graphical sudo (askpass) security contract
// — locked v1". These tests cover the contract's verification list for the
// Pickforge side: available/missing/headless preflight, cancellation, env
// propagation, arg-array safety, and redaction.
describe("privileged execution via graphical sudo (askpass)", () => {
  const sudoPath = "/usr/bin/sudo";

  it("materializes sudo -A with the resolved helper, adding only SUDO_ASKPASS to the env", () => {
    const adapter = createLocalExecutionAdapter({
      privilege: { sudoPath, askpass: AVAILABLE_ASKPASS },
    });
    const step = command("root", true, ["-r", "-M", "pickforge-lab"]);
    if (step.kind !== "command") throw new Error("expected a command step");
    step.command.env = { ANDROID_HOME: "/sdk" };

    const materialized = adapter.materialize(step);
    if (materialized.kind !== "command") {
      throw new Error("expected a command step");
    }
    expect(materialized.command).toEqual({
      cmd: sudoPath,
      args: ["-A", process.execPath, "-r", "-M", "pickforge-lab"],
      env: { ANDROID_HOME: "/sdk", SUDO_ASKPASS: "/usr/bin/ksshaskpass" },
    });
    // The raw step (and its env object) is untouched by materialization.
    expect(step.command.env).toEqual({ ANDROID_HOME: "/sdk" });
  });

  it("adds SUDO_ASKPASS as the only env key when the raw step declares no env", () => {
    const adapter = createLocalExecutionAdapter({
      privilege: { sudoPath, askpass: AVAILABLE_ASKPASS },
    });
    const materialized = adapter.materialize(command("root", true));
    if (materialized.kind !== "command") {
      throw new Error("expected a command step");
    }
    expect(materialized.command.env).toEqual({
      SUDO_ASKPASS: "/usr/bin/ksshaskpass",
    });
  });

  it("keeps a hostile argv element as one array entry through materialization (never a shell string)", () => {
    const adapter = createLocalExecutionAdapter({
      privilege: { sudoPath, askpass: AVAILABLE_ASKPASS },
    });
    const hostile = "$(touch /tmp/pwn) `evil`; rm -rf / | cat";
    const materialized = adapter.materialize(command("root", true, [hostile]));
    if (materialized.kind !== "command") {
      throw new Error("expected a command step");
    }
    expect(materialized.command.args).toEqual([
      "-A",
      process.execPath,
      hostile,
    ]);
    expect(materialized.command.args).toHaveLength(3);
  });

  it.each([
    ["headless" as const, /graphical session/i],
    ["no-helper" as const, /SUDO_ASKPASS helper/i],
    ["unsupported-platform" as const, /only supported on Linux/i],
  ])(
    "fails preflight, before any mutation, when askpass capability is %s",
    async (state, expected) => {
      const target = path.join(tmpDir, "should-not-exist");
      const result = await executeProvisioning(
        [
          {
            kind: "plan",
            plan: {
              steps: [
                {
                  id: "mk",
                  title: "mk",
                  kind: "mkdir",
                  privileged: false,
                  dir: target,
                },
              ],
            },
          },
          {
            kind: "plan",
            plan: { steps: [command("root", true)] },
            consent: { decide: async () => ({ kind: "approved" }) },
          },
        ],
        { privilege: { sudoPath, askpass: { state } } },
      );
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(expected);
      expect(result.error).toContain("Run it yourself in a terminal: sudo");
      expect(result.plan.steps.map((step) => step.id)).toEqual(["mk"]);
      expect(result.results).toEqual([]);
      expect(fs.existsSync(target)).toBe(false);
    },
  );

  it("prefixes an askpass-unavailable reason with the section's privilegeUnavailable.context, like its sibling skip reasons", async () => {
    // Regression: a section's static privilegeUnavailable.reason only ever
    // applied to the sudo-missing failure mode; an askpass-unavailable
    // failure used to drop the section's own "lab-user: "-style context
    // entirely. `context` is the section's dedicated way to keep it.
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: { steps: [command("root", true)] },
          privilegeUnavailable: {
            action: "skip",
            reason: "lab-user: sudo not found on PATH",
            context: "lab-user: ",
          },
        },
      ],
      { privilege: { sudoPath, askpass: { state: "headless" } } },
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatch(/^lab-user: No graphical session detected/);
    // The sudo-missing-only reason must never leak into this failure mode.
    expect(result.skipped[0]).not.toContain("sudo not found on PATH");
  });

  it("uses the bare askpass-unavailable message when the section supplies no context", async () => {
    const result = await executeProvisioning(
      [
        {
          kind: "plan",
          plan: { steps: [command("root", true)] },
          privilegeUnavailable: {
            action: "skip",
            reason: "some other static reason",
          },
        },
      ],
      { privilege: { sudoPath, askpass: { state: "headless" } } },
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatch(/^No graphical session detected/);
  });

  it("fails preflight when privilege.askpass is omitted entirely (fail-closed default)", async () => {
    const result = await executeProvisioning(
      [approved({ steps: [command("root", true)] })],
      { privilege: { sudoPath } },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/graphical session/i);
  });

  it(
    "surfaces sudo cancellation/denial as a distinct 'cancelled' status, " +
      "with no retry and an actionable manual fallback",
    async () => {
      const fakeSudo = path.join(tmpDir, "fake-sudo.cjs");
      const record = path.join(tmpDir, "fake-sudo-invocations.log");
      fs.writeFileSync(
        fakeSudo,
        "#!/usr/bin/env node\n" +
          `require("fs").appendFileSync(${JSON.stringify(record)}, "invoked\\n");\n` +
          'process.stderr.write("sudo: a password is required\\n");\n' +
          "process.exit(1);\n",
      );
      fs.chmodSync(fakeSudo, 0o755);

      const result = await executeProvisioning(
        [
          approved({
            steps: [command("root", true, ["-r", "-M", "pickforge-lab"])],
          }),
        ],
        { privilege: { sudoPath: fakeSudo, askpass: AVAILABLE_ASKPASS } },
      );

      expect(result.status).toBe("cancelled");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("sudo denied or cancelled");
      expect(result.error).toContain("run it yourself in a terminal: sudo");
      expect(result.results).toEqual([
        {
          id: "root",
          ok: false,
          detail: expect.stringContaining("cancelled"),
        },
      ]);
      // No automatic retry loop: the stand-in sudo ran exactly once.
      expect(fs.readFileSync(record, "utf8").trim().split("\n")).toEqual([
        "invoked",
      ]);
    },
  );

  it("redacts credential-shaped text out of a sudo denial message before it reaches the result", async () => {
    const fakeSudo = path.join(tmpDir, "fake-sudo-secret.cjs");
    fs.writeFileSync(
      fakeSudo,
      "#!/usr/bin/env node\n" +
        'process.stderr.write("sudo: a password is required (token=planted-secret)\\n");\n' +
        "process.exit(1);\n",
    );
    fs.chmodSync(fakeSudo, 0o755);

    const result = await executeProvisioning(
      [approved({ steps: [command("root", true)] })],
      { privilege: { sudoPath: fakeSudo, askpass: AVAILABLE_ASKPASS } },
    );

    expect(result.status).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("planted-secret");
    expect(result.error).toContain("[REDACTED]");
  });

  it("lets a custom adapter raise the same distinct cancelled state via the exported error class", async () => {
    const result = await executeProvisioning(
      [approved({ steps: [command("root", true)] })],
      {
        adapter: {
          materialize: (step) => step,
          execute: async () => {},
          executePrivileged: async () => {
            throw new PrivilegedCommandDeniedError(
              "sudo denied or cancelled this privileged command: test double",
            );
          },
        },
      },
    );
    expect(result.status).toBe("cancelled");
  });
});
