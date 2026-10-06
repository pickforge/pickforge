// Test budget for each built CLI spawn. Under CPU contention one spawn can take
// several seconds, so tests that spawn the CLI more than once size their
// timeout by spawn count instead of relying on vitest's 5 s default.
export const CLI_SPAWN_BUDGET_MS = 10_000;

export function cliSpawnTimeout(spawns: number): number {
  return spawns * CLI_SPAWN_BUDGET_MS;
}
