import { redactSecrets } from "@pickforge/lab-core";
import { runProjectDevtoolsMcp } from "@pickforge/lab-browser";
import { resolveProjectDir } from "./shared.js";

export interface BrowserDevtoolsMcpOptions {
  projectDir?: string;
}

export interface BrowserDevtoolsMcpDependencies {
  runRelay?: typeof runProjectDevtoolsMcp;
  signalCurrentProcess?: (signal: NodeJS.Signals) => void;
  exitProcess?: (code: number) => void;
}

export async function runBrowserDevtoolsMcp(
  opts: BrowserDevtoolsMcpOptions,
  dependencies: BrowserDevtoolsMcpDependencies = {},
): Promise<number> {
  try {
    const exit = await (dependencies.runRelay ?? runProjectDevtoolsMcp)({
      projectDir: resolveProjectDir(opts),
    });
    if (exit.signal === "SIGKILL") {
      (dependencies.exitProcess ??
        ((code) => {
          process.exit(code);
        }))(137);
      return 137;
    }
    if (exit.signal !== null) {
      (dependencies.signalCurrentProcess ??
        ((signal) => {
          process.kill(process.pid, signal);
        }))(exit.signal);
      return 128;
    }
    return exit.code ?? 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${redactSecrets(message)}\n`);
    return 1;
  }
}
