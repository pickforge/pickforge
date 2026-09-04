import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, updateSession } from "../src/session.js";
import {
  resolveDesktopCapableSession,
  resolveRunnableSession,
  resolveScreenshotTarget,
} from "../src/target.js";

let home: string;
let env: { PICKFORGE_HOME: string };

const HINTS = {
  consumerLabel: "test",
  createHint: "create one first",
  selectHint: "pick one explicitly",
};

async function createRunningDesktop(projectDir: string): Promise<string> {
  const record = await createSession({ type: "desktop", projectDir }, env);
  await updateSession(
    record.id,
    { status: "running", desktop: { display: ":99" } },
    env,
  );
  return record.id;
}

async function createRunningBrowser(projectDir: string): Promise<string> {
  const record = await createSession({ type: "browser", projectDir }, env);
  await updateSession(
    record.id,
    {
      status: "running",
      desktop: { display: ":120", xvfbPid: 4242, width: 1280, height: 800 },
      browser: {
        browserPid: 4243,
        browserStartTimeTicks: 5,
        binaryPath: "/usr/bin/chromium",
        profileMode: "ephemeral",
        profileDir: "/tmp/pickforge-lab-profile",
        cdpPort: 1,
      },
    },
    env,
  );
  return record.id;
}

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-target-"));
  env = { PICKFORGE_HOME: home };
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

describe("resolveRunnableSession project scoping", () => {
  it("resolves each project's own session when two projects run concurrently", async () => {
    const idA = await createRunningDesktop("/proj-a");
    const idB = await createRunningDesktop("/proj-b");

    const recordA = await resolveRunnableSession("desktop", undefined, {
      env,
      projectDir: "/proj-a",
      ...HINTS,
    });
    const recordB = await resolveRunnableSession("desktop", undefined, {
      env,
      projectDir: "/proj-b",
      ...HINTS,
    });
    expect(recordA.id).toBe(idA);
    expect(recordB.id).toBe(idB);
  });

  it("reports project-scoped ambiguity when one project has two sessions", async () => {
    const first = await createRunningDesktop("/proj-a");
    const second = await createRunningDesktop("/proj-a");

    const error = await resolveRunnableSession("desktop", undefined, {
      env,
      projectDir: "/proj-a",
      ...HINTS,
    }).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toContain(
      "Multiple running desktop sessions for this project",
    );
    expect(error?.message).toContain(first);
    expect(error?.message).toContain(second);
    expect(error?.message).toContain("pick one explicitly");
  });

  it("reports a project-scoped miss when only other projects have sessions", async () => {
    await createRunningDesktop("/proj-b");

    await expect(
      resolveRunnableSession("desktop", undefined, {
        env,
        projectDir: "/proj-a",
        ...HINTS,
      }),
    ).rejects.toThrow(
      /No running desktop session for this project; create one first/,
    );
  });

  it("keeps the unscoped error semantics when no projectDir is given", async () => {
    await createRunningDesktop("/proj-a");
    await createRunningDesktop("/proj-b");

    await expect(
      resolveRunnableSession("desktop", undefined, { env, ...HINTS }),
    ).rejects.toThrow(/Multiple running desktop sessions found/);
  });

  it("lets explicit session ids bypass the project filter", async () => {
    const idB = await createRunningDesktop("/proj-b");

    const record = await resolveRunnableSession("desktop", idB, {
      env,
      projectDir: "/proj-a",
      ...HINTS,
    });
    expect(record.id).toBe(idB);
    expect(record.projectDir).toBe("/proj-b");
  });
});

describe("resolveRunnableSession capability model", () => {
  it("resolves a browser session for a desktop consumer via its shared desktop leg", async () => {
    const id = await createRunningBrowser("/proj-a");
    const record = await resolveRunnableSession("desktop", undefined, {
      env,
      projectDir: "/proj-a",
      ...HINTS,
    });
    expect(record.id).toBe(id);
    expect(record.type).toBe("browser");
  });

  it("resolves a browser session for a browser consumer", async () => {
    const id = await createRunningBrowser("/proj-a");
    const record = await resolveRunnableSession("browser", undefined, {
      env,
      projectDir: "/proj-a",
      ...HINTS,
    });
    expect(record.id).toBe(id);
  });

  it("fails closed when only a desktop-only session exists for a browser consumer", async () => {
    await createRunningDesktop("/proj-a");
    await expect(
      resolveRunnableSession("browser", undefined, {
        env,
        projectDir: "/proj-a",
        ...HINTS,
      }),
    ).rejects.toThrow(/No running browser session for this project/);
  });

  it("does not treat a browser session as an android capability", async () => {
    await createRunningBrowser("/proj-a");
    await expect(
      resolveRunnableSession("android", undefined, {
        env,
        projectDir: "/proj-a",
        ...HINTS,
      }),
    ).rejects.toThrow(/No running android session for this project/);
  });

  it("rejects an explicit id that lacks the requested capability", async () => {
    const id = await createRunningDesktop("/proj-a");
    await expect(
      resolveRunnableSession("browser", id, { env, ...HINTS }),
    ).rejects.toThrow(/is of type "desktop" and has no browser capability/);
  });

  it("counts a browser session alongside a plain desktop session as desktop ambiguity", async () => {
    const desk = await createRunningDesktop("/proj-a");
    const brow = await createRunningBrowser("/proj-a");

    const error = await resolveRunnableSession("desktop", undefined, {
      env,
      projectDir: "/proj-a",
      ...HINTS,
    }).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toContain(
      "Multiple running desktop sessions for this project",
    );
    expect(error?.message).toContain(desk);
    expect(error?.message).toContain(brow);
  });
});

describe("resolveDesktopCapableSession", () => {
  it("gives a create hint when no running desktop session exists", async () => {
    await expect(
      resolveDesktopCapableSession(undefined, {
        env,
        projectDir: "/proj-a",
      }),
    ).rejects.toThrow(
      /No running desktop session for this project; create one with: pickforge-lab session create --type desktop/,
    );
  });

  it("uses the shared desktop capability for browser records", async () => {
    const id = await createRunningBrowser("/proj-a");
    const record = await resolveDesktopCapableSession(undefined, {
      env,
      projectDir: "/proj-a",
    });
    expect(record.id).toBe(id);
    expect(record.type).toBe("browser");
  });

  it("fails closed and names all desktop-capable candidates", async () => {
    const desktop = await createRunningDesktop("/proj-a");
    const browser = await createRunningBrowser("/proj-a");
    const error = await resolveDesktopCapableSession(undefined, {
      env,
      projectDir: "/proj-a",
    }).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toContain(
      "Multiple running desktop sessions for this project",
    );
    expect(error?.message).toContain(desktop);
    expect(error?.message).toContain(browser);
    expect(error?.message).toContain("--session <id>");
  });

  it("rejects explicit non-desktop and stopped sessions", async () => {
    const android = await createSession(
      { type: "android", projectDir: "/proj-a", status: "running" },
      env,
    );
    const stopped = await createSession(
      {
        type: "desktop",
        projectDir: "/proj-a",
        status: "stopped",
        desktop: { display: ":80" },
      },
      env,
    );

    await expect(
      resolveDesktopCapableSession(android.id, { env }),
    ).rejects.toThrow(/has no desktop capability/);
    await expect(
      resolveDesktopCapableSession(stopped.id, { env }),
    ).rejects.toThrow(/not running/);
  });
});

describe("resolveScreenshotTarget out confinement", () => {
  const COMMON = {
    projectDir: "/proj",
    defaultSlug: "desktop",
    conflictError: "use either --out or --run, not both",
  };

  it("leaves CLI-style out unrestricted when no outBaseDir is given", async () => {
    const target = await resolveScreenshotTarget({
      ...COMMON,
      out: "/tmp/anywhere/shot.png",
    });
    expect(target.outPath).toBe(path.resolve("/tmp/anywhere/shot.png"));
    expect(target.run).toBeUndefined();
  });

  it("confines an MCP-style relative out under the base dir", async () => {
    const base = path.resolve("/base");
    const target = await resolveScreenshotTarget({
      ...COMMON,
      out: "shots/shot.png",
      outBaseDir: base,
    });
    expect(target.outPath).toBe(path.join(base, "shots", "shot.png"));
  });

  it("rejects a relative out that escapes the base dir", async () => {
    await expect(
      resolveScreenshotTarget({
        ...COMMON,
        out: "../escape.png",
        outBaseDir: path.resolve("/base"),
      }),
    ).rejects.toThrow(/outside the project directory/);
  });

  it("rejects an out whose path symlinks outside the base dir", async () => {
    const project = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-proj-"),
    );
    const outside = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-outside-"),
    );
    await fs.promises.symlink(outside, path.join(project, "link"));
    try {
      await expect(
        resolveScreenshotTarget({
          ...COMMON,
          out: "link/shot.png",
          outBaseDir: project,
        }),
      ).rejects.toThrow(/outside the project directory/);
    } finally {
      await fs.promises.rm(project, { recursive: true, force: true });
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects an out that is a dangling symlink pointing outside the base dir", async () => {
    const project = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-proj-"),
    );
    // Dangling symlink: target does not exist, so realpath cannot resolve it,
    // but a subsequent write would follow it and create the outside file.
    await fs.promises.symlink(
      "outside/shot.png",
      path.join(project, "shot.png"),
    );
    try {
      await expect(
        resolveScreenshotTarget({
          ...COMMON,
          out: "shot.png",
          outBaseDir: project,
        }),
      ).rejects.toThrow(/outside the project directory/);
    } finally {
      await fs.promises.rm(project, { recursive: true, force: true });
    }
  });

  it("rejects an absolute out outside the base dir", async () => {
    await expect(
      resolveScreenshotTarget({
        ...COMMON,
        out: "/etc/passwd",
        outBaseDir: path.resolve("/base"),
      }),
    ).rejects.toThrow(/outside the project directory/);
  });
});
