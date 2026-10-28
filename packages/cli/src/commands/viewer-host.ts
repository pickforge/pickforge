import { runNativeViewerHost } from "../viewer/native-host.js";

export async function runViewerHost(options: { session: string; binary: string; viewerVersion: string }): Promise<number> {
  try { return await runNativeViewerHost(options); }
  catch { console.error("Native viewer host startup failed"); return 1; }
}
