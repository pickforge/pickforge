import {
  withViewerDir,
  readViewerPrivateFile,
} from "@pickforge/lab-desktop-linux";
import { startViewerBridge } from "../viewer/bridge.js";

/** Detached internal command. Failures are coarse and contain no request data. */
export async function runViewerBridge(options: {
  session: string;
}): Promise<number> {
  try {
    const token = await withViewerDir(
      options.session,
      process.env,
      false,
      (directory) => readViewerPrivateFile(directory, "token"),
    );
    if (token === undefined) {
      throw new Error("Missing capability");
    }
    await startViewerBridge({ sessionId: options.session, token });
    return 0;
  } catch {
    console.error("Viewer bridge startup failed");
    return 1;
  }
}
