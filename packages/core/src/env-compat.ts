export type EnvLike = Record<string, string | undefined>;

const warnedLegacyNames = new Set<string>();

/** Read a PICKFORGE_* variable, falling back to its deprecated PICKLAB_* name. */
export function readPickforgeEnv(
  env: EnvLike,
  suffix: string,
): string | undefined {
  const currentName = `PICKFORGE_${suffix}`;
  const current = env[currentName];
  if (current !== undefined) {
    return current;
  }

  const legacyName = `PICKLAB_${suffix}`;
  const legacy = env[legacyName];
  if (legacy !== undefined && !warnedLegacyNames.has(legacyName)) {
    warnedLegacyNames.add(legacyName);
    console.error(`warning: ${legacyName} is deprecated; use ${currentName} instead`);
  }
  return legacy;
}
