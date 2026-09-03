import fs from "node:fs";

export const BACKUP_PATTERN =
  /\.(?:pickforge|picklab)-backup-\d{8}-\d{6}(-\d+)?$/;

function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function isBackupPath(filePath: string): boolean {
  return BACKUP_PATTERN.test(filePath);
}

export async function backupFile(
  filePath: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  const base = `${filePath}.pickforge-backup-${timestamp(now)}`;
  let candidate = base;
  for (let attempt = 2; ; attempt += 1) {
    try {
      await fs.promises.copyFile(
        filePath,
        candidate,
        fs.constants.COPYFILE_EXCL,
      );
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return undefined;
      }
      if (code !== "EEXIST") {
        throw error;
      }
    }
    candidate = `${base}-${attempt}`;
  }
}
