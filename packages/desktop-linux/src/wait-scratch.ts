import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { DirHandle } from "@pickforge/lab-core";

/** Private wait workspace, held through capture, comparison and known-entry cleanup. */
export class WaitScratch {
  private constructor(
    private readonly parent: DirHandle,
    private readonly dir: DirHandle,
    private readonly name: string,
    private readonly files: Map<string, fs.promises.FileHandle>,
  ) {}

  static async create(): Promise<WaitScratch> {
    const parent = await DirHandle.open(os.tmpdir(), { followFinal: true });
    const name = `pickforge-desktop-wait-${crypto.randomBytes(12).toString("hex")}`;
    try {
      await parent.mkdirChild(name, 0o700);
      const dir = await parent.openChild(name);
      return new WaitScratch(parent, dir, name, new Map());
    } catch (error) {
      await parent.close();
      throw error;
    }
  }

  async file(name: string): Promise<string> {
    if (!this.files.has(name)) this.files.set(name, await this.dir.openFile(name, "wx", 0o600));
    await this.verify(name);
    // Subprocesses must address the parent's descriptors, not their own /proc/self.
    return this.dir.resolve(name).replace("/proc/self/", `/proc/${process.pid}/`);
  }

  async write(name: string, bytes: Buffer): Promise<string> {
    const filePath = await this.file(name);
    const file = this.files.get(name)!;
    await file.truncate(0);
    await file.writeFile(bytes);
    await this.verify(name);
    return filePath;
  }

  async verify(name: string): Promise<void> {
    const expected = await this.files.get(name)!.stat();
    const current = await this.dir.lstatChild(name);
    if (!current?.isFile() || current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error(`Wait scratch entry was replaced: ${name}`);
    }
  }

  async close(): Promise<void> {
    try {
      const cleanups = await Promise.allSettled([...this.files].map(async ([name, file]) => {
        try {
          await this.verify(name);
          await this.dir.unlinkChild(name);
        } finally {
          await file.close();
        }
      }));
      const failed = cleanups.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const current = await this.parent.lstatChild(this.name);
      if (!current?.isDirectory() || current.dev !== this.dir.stat.dev || current.ino !== this.dir.stat.ino) {
        throw new Error("Wait scratch directory was replaced; refusing cleanup");
      }
      // Never recursively remove unknown entries, including on capture failure.
      await fs.promises.rmdir(this.parent.resolve(this.name));
    } finally {
      await this.dir.close();
      await this.parent.close();
    }
  }
}
