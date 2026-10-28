import { vi } from "vitest";

// Waits on subprocesses can take over a second on a loaded runner, so
// vi.waitFor gets the same 5 s default as expect.poll. Vitest has no config
// option for it.
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(
    callback,
    typeof options === "number" ? options : { timeout: 5_000, ...options },
  )) as typeof vi.waitFor;
