import fs from "node:fs";
import path from "node:path";
import { DirHandle, RunStorageAccessError, withDirHandle } from "./dir-handle.js";

export const MAX_BASELINE_BYTES = 64 * 1024 * 1024;
export class ObservationTimeoutError extends Error {}

export function observationBudget(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ObservationTimeoutError("Observation deadline exhausted");
  return remaining;
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  if (!a.isFile() || !b.isFile()) return false;
  const fields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const;
  return fields.every((field) => a[field] === b[field]);
}

/** Read only the verified opened regular file, in bounded chunks, never waiting on a FIFO. */
export async function readBoundedFileIn(
  dir: DirHandle, name: string, deadline: number,
): Promise<Buffer> {
  observationBudget(deadline);
  const before = await dir.lstatChild(name);
  if (!before?.isFile()) throw new RunStorageAccessError("Baseline is not a regular file");
  const file = await dir.openFile(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!sameFile(before, opened)) throw new RunStorageAccessError("Baseline was replaced before reading");
    if (opened.size > MAX_BASELINE_BYTES) throw new RunStorageAccessError(`Baseline exceeds ${MAX_BASELINE_BYTES} bytes`);
    observationBudget(deadline);
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      observationBudget(deadline);
      const { bytesRead } = await file.read(data, offset, Math.min(65536, data.length - offset), offset);
      if (bytesRead === 0) throw new RunStorageAccessError("Baseline changed while reading");
      offset += bytesRead;
    }
    const after = await dir.lstatChild(name);
    if (!after || !sameFile(opened, after) || !sameFile(opened, await file.stat())) {
      throw new RunStorageAccessError("Baseline changed while reading");
    }
    observationBudget(deadline);
    return data;
  } finally {
    await file.close();
  }
}

/** Walk from a held trusted project directory; no later pathname authorization is used. */
export async function readProjectFileBounded(
  projectDir: string, requestedPath: string, deadline: number,
): Promise<Buffer> {
  observationBudget(deadline);
  const relative = path.relative(path.resolve(projectDir), path.resolve(projectDir, requestedPath));
  const parts = relative.split(path.sep);
  if (!relative || path.isAbsolute(relative) || parts.some((part) => part === ".." || part === "")) {
    throw new RunStorageAccessError("Baseline is outside the project directory");
  }
  const expectedRealDir = await fs.promises.realpath(projectDir);
  const expectedIdentity = await fs.promises.stat(expectedRealDir);
  return withDirHandle(DirHandle.open(projectDir, { followFinal: true, expectedRealDir, expectedIdentity }), async (root) => {
    let dir = root;
    try {
      for (const part of parts.slice(0, -1)) {
        observationBudget(deadline);
        const child = await dir.openChild(part);
        if (dir !== root) await dir.close();
        dir = child;
      }
      return await readBoundedFileIn(dir, parts[parts.length - 1]!, deadline);
    } finally {
      if (dir !== root) await dir.close();
    }
  });
}

/** CLI paths are unrestricted; the parent and actual file are still pinned during the read. */
export async function readBaselineFile(filePath: string, deadline: number): Promise<Buffer> {
  observationBudget(deadline);
  const resolved = await fs.promises.realpath(filePath);
  return withDirHandle(DirHandle.open(path.dirname(resolved), { followFinal: true }),
    (dir) => readBoundedFileIn(dir, path.basename(resolved), deadline));
}
