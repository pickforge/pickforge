import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WaitScratch } from "../src/wait-scratch.js";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("cleans known owned entries through a held renamed scratch directory", async () => {
  const scratch = await WaitScratch.create();
  const sample = await scratch.file("sample.png");
  const original = fs.realpathSync(path.dirname(sample));
  const moved = `${original}-moved`;
  fixtures.push(original, moved);
  fs.renameSync(original, moved);
  fs.mkdirSync(original);
  fs.writeFileSync(path.join(original, "unrelated"), "keep");
  fs.writeFileSync(sample, "owned");
  await expect(scratch.close()).rejects.toThrow(/directory was replaced/);
  expect(fs.existsSync(path.join(moved, "sample.png"))).toBe(false);
  expect(fs.readFileSync(path.join(original, "unrelated"), "utf8")).toBe("keep");
});

it("refuses substituted files and preserves unknown scratch entries", async () => {
  const scratch = await WaitScratch.create();
  const sample = await scratch.file("sample.png");
  const real = fs.realpathSync(path.dirname(sample));
  fixtures.push(real);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-outside-"));
  fixtures.push(outside);
  fs.writeFileSync(path.join(outside, "keep"), "outside");
  fs.unlinkSync(sample);
  fs.symlinkSync(path.join(outside, "keep"), sample);
  await expect(scratch.close()).rejects.toThrow(/entry was replaced/);
  expect(fs.lstatSync(path.join(real, "sample.png")).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("outside");
  const unknown = await WaitScratch.create();
  const known = await unknown.file("sample.png");
  const dir = fs.realpathSync(path.dirname(known));
  fixtures.push(dir);
  fs.writeFileSync(path.join(dir, "unknown"), "keep");
  await expect(unknown.close()).rejects.toMatchObject({ code: "ENOTEMPTY" });
  expect(fs.readFileSync(path.join(dir, "unknown"), "utf8")).toBe("keep");
});
