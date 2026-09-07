import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/lab/chrome-egress-check.mjs");
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-report-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function report(log: unknown): string {
  const file = path.join(dir, "netlog.json");
  fs.writeFileSync(file, JSON.stringify(log));
  return execFileSync(process.execPath, [script, "--parse-net-log", file], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("Chrome egress NetLog report (no browser)", () => {
  it("prints remote request, DNS and socket destinations without URL credentials or queries", () => {
    const output = report({ events: [{ params: {
      url: "https://user:password@vendor.example/register?token=secret",
      host: "dns.example:443",
      address_list: ["203.0.113.1:443", "[2001:db8::1]:443"],
      nested: { remote_address: "192.0.2.2:5228" },
      local_address: "192.168.1.2:34567",
    } }] });
    for (const host of ["vendor.example", "dns.example:443", "203.0.113.1:443", "[2001:db8::1]:443", "192.0.2.2:5228"]) {
      expect(output).toContain(host);
    }
    for (const privateValue of ["password", "secret", "register", "192.168.1.2"]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("excludes loopback, non-network URLs and unrelated event strings", () => {
    const output = report({ events: [{ params: {
      addresses: ["127.0.0.1:9222", "127.5.6.7:80", "[::1]:80", "[::ffff:127.0.0.1]:80", "localhost:8080"],
      url: "about:blank", message: "not-a-destination.example",
    } }] });
    expect(output).toContain("(none observed)");
    expect(output).not.toContain("not-a-destination.example");
  });

  it("reports unparseable destination fields rather than silently dropping them", () => {
    const output = report({ events: [{ params: { address: "unexpected endpoint format" } }] });
    expect(output).toContain("Unparseable destination fields: 1");
    expect(output).not.toContain("unexpected endpoint format");
  });

  it("fails instead of calling an empty or invalid capture quiet", () => {
    expect(() => report({ events: [] })).toThrow();
    expect(() => report({})).toThrow();
  });
});
