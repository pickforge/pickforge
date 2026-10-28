import { deleteBrowserProfile, listBrowserProfiles, validateBrowserProfileName } from "@pickforge/lab-browser";
import { confirm } from "../provision/prompts.js";
import { runReported, type BaseCliOptions } from "./shared.js";

export async function runProfileList(opts: BaseCliOptions): Promise<number> {
  return runReported(opts, async () => {
    const profiles = await listBrowserProfiles();
    return {
      data: { profiles },
      lines: profiles.map((profile) =>
        "error" in profile ? `${profile.name}  ${profile.error}` :
        `${profile.name}  ${profile.sizeBytes} bytes  ${profile.lastUsedAt}  ${profile.holdingSession ?? "-"}`),
    };
  });
}

export async function runProfileDelete(name: string, opts: BaseCliOptions & { yes?: boolean }): Promise<number> {
  return runReported(opts, async () => {
    validateBrowserProfileName(name);
    const answer = await confirm(`Delete browser profile "${name}" and all its stored logins?`, opts);
    if (answer !== "yes") {
      throw new Error(answer === "non-interactive"
        ? "Profile deletion requires --yes without an interactive terminal"
        : "Profile deletion cancelled");
    }
    await deleteBrowserProfile(name);
    return { data: { deleted: name }, lines: [`deleted browser profile ${name}`] };
  });
}
