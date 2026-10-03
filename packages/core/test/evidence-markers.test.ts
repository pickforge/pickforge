import { describe, expect, it } from "vitest";
import {
  renderEvidenceHtml,
  reportContentSecurityPolicy,
  type EvidenceAction,
  type EvidenceRecord,
  type RunManifest,
} from "../src/index.js";

const BEFORE = "screenshots/click-before.png";
const AFTER = "screenshots/click-after.png";

function manifest(): RunManifest {
  return {
    runId: "20261003-120000-markers", slug: "markers", createdAt: "2026-10-03T12:00:00.000Z",
    status: "completed", artifacts: [], evidenceVersion: 1, actionLog: "actions.jsonl",
  };
}

function pointer(overrides: Partial<EvidenceAction> = {}): EvidenceAction {
  return {
    actionId: "act-1", source: "mcp", tool: "desktop_click", startedAt: "2026-10-03T12:00:00.000Z", status: "ok",
    inputState: "completed", target: { x: 640, y: 400, coordinateSpace: "xvfb-root" }, artifacts: [BEFORE, AFTER],
    captures: [
      { path: BEFORE, phase: "before", width: 1280, height: 800 },
      { path: AFTER, phase: "after", width: 1280, height: 800 },
    ],
    ...overrides,
  };
}

function render(records: readonly EvidenceRecord[]): string {
  const paths = records.flatMap((record) => ("artifacts" in record ? record.artifacts ?? [] : []));
  return renderEvidenceHtml(manifest(), records, new Set(paths));
}

function count(html: string, text: string): number {
  return html.split(text).length - 1;
}

function scriptOf(html: string): string {
  return /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
}

function cspOf(html: string): string {
  return /content="([^"]*)"/.exec(html)![1]!;
}

function unmarked(record: EvidenceAction): EvidenceAction {
  const { captures: _captures, inputState: _inputState, ...rest } = record;
  return rest;
}

function share(paths: readonly string[]) {
  const hashes = new Map(paths.map((relative, index) => [relative, `h${index}`]));
  const payloads = Object.fromEntries(paths.map((_relative, index) => [`h${index}`, "AAAA"]));
  return { hashes, payloads, bytes: 3 * paths.length, omitted: new Map<string, string>() };
}

describe("evidence report pointer markers", () => {
  it("rings a completed click on its linked before and after captures", () => {
    const html = render([pointer()]);
    // Each capture appears in the gallery and in its inspect view.
    expect(count(html, '<span class="pointer pointer-ring" style="--x:50.0391%;--y:50.0625%" aria-hidden="true">')).toBe(4);
    expect(count(html, '<span class="image-frame" style="--w:1280;--h:800">')).toBe(4);
    expect(count(html, '<span class="stage framed">')).toBe(2);
    expect(count(html, '<div class="inspect-stage framed">')).toBe(2);
    expect(html).toContain(`<span class="image-frame" style="--w:1280;--h:800"><img src="${BEFORE}"`);
    expect(count(html, '<span class="mono">Pointer: click at 640, 400 · before · completed</span>')).toBe(1);
    expect(count(html, '<span class="mono">Pointer: click at 640, 400 · after · completed</span>')).toBe(1);
    expect(count(html, '<span class="pointer-note">Pointer: click at 640, 400 · before · completed</span>')).toBe(1);
    expect(html).not.toContain('class="pointer pointer-line"');
    expect(html).not.toContain("image-frame attempted");
  });

  it("draws a dashed drag line from start to destination for attempted input", () => {
    const html = render([pointer({
      tool: "desktop_drag", inputState: "attempted",
      target: { fromX: 10, fromY: 20, x: 640, y: 400, coordinateSpace: "xvfb-root" },
    })]);
    expect(count(html, '<span class="image-frame attempted" style="--w:1280;--h:800">')).toBe(4);
    expect(count(html, '<svg class="pointer pointer-line" viewBox="0 0 1280 800" preserveAspectRatio="none" aria-hidden="true" focusable="false">')).toBe(4);
    expect(html).toContain('<line class="halo" x1="10.5" y1="20.5" x2="640.5" y2="400.5" vector-effect="non-scaling-stroke"/><line x1="10.5" y1="20.5" x2="640.5" y2="400.5" vector-effect="non-scaling-stroke"/>');
    expect(count(html, '<span class="pointer pointer-dot" style="--x:0.8203%;--y:2.5625%" aria-hidden="true">')).toBe(4);
    expect(count(html, '<span class="pointer pointer-ring" style="--x:50.0391%;--y:50.0625%" aria-hidden="true">')).toBe(4);
    expect(html).toContain("Pointer: drag 10, 20 → 640, 400 · after · attempted");
    expect(html).toContain(".attempted .pointer-ring{border-style:dashed}");
    expect(html).toContain(".attempted .pointer-line line{stroke-dasharray:6 4;stroke-linecap:butt}");
  });

  it("places points at pixel centres across the whole image", () => {
    const corner = (x: number, y: number) => render([pointer({
      target: { x, y, coordinateSpace: "xvfb-root" },
      captures: [{ path: BEFORE, phase: "before", width: 200, height: 120 }],
    })]);
    expect(corner(0, 0)).toContain('style="--x:0.25%;--y:0.4167%"');
    expect(corner(199, 119)).toContain('style="--x:99.75%;--y:99.5833%"');
    expect(corner(199, 119)).toContain('style="--w:200;--h:120"');
  });

  it("only marks the captures the action links to", () => {
    const html = render([pointer({ captures: [{ path: AFTER, phase: "after", width: 1280, height: 800 }] })]);
    expect(html).toContain(`<span class="stage"><img src="${BEFORE}"`);
    expect(html).toContain(`<span class="stage framed"><span class="image-frame" style="--w:1280;--h:800"><img src="${AFTER}"`);
    expect(count(html, "pointer pointer-ring")).toBe(2);
  });

  const outOfBounds = { x: 1280, y: 400, coordinateSpace: "xvfb-root" };
  it.each<[string, Partial<EvidenceAction>]>([
    ["not-attempted input", { inputState: "not-attempted" }],
    ["a missing input state", { inputState: undefined }],
    ["an unknown input state", { inputState: "done" as never }],
    ["missing captures", { captures: undefined }],
    ["malformed captures", { captures: "screenshots/click-before.png" as never }],
    ["an unknown phase", { captures: [{ path: BEFORE, phase: "during" as never, width: 1280, height: 800 }] }],
    ["duplicate phases", { captures: [
      { path: BEFORE, phase: "before", width: 1280, height: 800 },
      { path: AFTER, phase: "before", width: 1280, height: 800 },
    ] }],
    ["a missing coordinate space", { target: { x: 640, y: 400 } }],
    ["an unknown coordinate space", { target: { x: 640, y: 400, coordinateSpace: "screen" } }],
    ["an x at the image width", { target: outOfBounds }],
    ["a y at the image height", { target: { x: 10, y: 800, coordinateSpace: "xvfb-root" } }],
    ["a negative point", { target: { x: -1, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a fractional point", { target: { x: 10.4, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a drag start outside the image", { tool: "desktop_drag", target: { fromX: 1280, fromY: 0, x: 10, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a partial drag start", { tool: "desktop_drag", target: { fromX: 5, x: 10, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a link to a path outside the artifacts", { artifacts: [AFTER], captures: [{ path: BEFORE, phase: "before", width: 1280, height: 800 }] }],
    ["a capture with a zero size", { captures: [{ path: BEFORE, phase: "before", width: 0, height: 800 }] }],
  ])("renders %s exactly as an unmarked record", (_label, change) => {
    const record = pointer(change);
    const html = render([record]);
    expect(html).toBe(render([unmarked(record)]));
    for (const text of ['class="pointer', "Pointer:", 'id="markers"', "image-frame", "framed", "container-type"]) {
      expect(html).not.toContain(text);
    }
  });

  it("never marks another action's capture", () => {
    const other = "screenshots/other.png";
    const records: EvidenceRecord[] = [
      pointer({ artifacts: [BEFORE], captures: [{ path: other, phase: "after", width: 1280, height: 800 }] }),
      { actionId: "act-2", source: "mcp", tool: "desktop_screenshot", startedAt: "2026-10-03T12:00:01.000Z", status: "ok", artifacts: [other] },
    ];
    const html = render(records);
    expect(html).toContain(`src="${other}"`);
    expect(html).not.toContain('class="pointer');
  });

  it("emits the checked overlay toggle only when a marker renders", () => {
    const marked = render([pointer()]);
    expect(marked).toContain('<input type="checkbox" class="marker-input" id="markers" checked>\n<div class="shell">');
    expect(marked).toContain('</span></h2><label class="btn marker-label" for="markers">Pointer markers</label>');
    expect(marked).toContain("#markers:not(:checked)~.shell .pointer,#markers:not(:checked)~.inspect .pointer{display:none}");
    expect(marked).toContain('#markers:checked~.shell label[for="markers"]{background:rgba(255,122,26,.08)');
    expect(marked).toContain('#markers:focus-visible~.shell label[for="markers"]{outline:2px solid var(--ember);outline-offset:2px}');
    const plain = render([unmarked(pointer())]);
    for (const text of ['id="markers"', 'for="markers"', "marker-input", ".framed"]) expect(plain).not.toContain(text);
  });

  it("keeps the CSP, the pinned script, determinism and escaping", () => {
    const record = pointer({ tool: 'desktop_<img src=x onerror=alert(1)>' });
    const html = render([record]);
    expect(html).toBe(render([record]));
    expect(cspOf(html)).toBe(reportContentSecurityPolicy());
    expect(scriptOf(html)).toBe(scriptOf(render([])));
    expect(count(html, "<script")).toBe(1);
    expect(html).toContain("Pointer: &lt;img src=x onerror=alert(1)&gt; at 640, 400");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/https?:|url\(/);
  });

  it("carries markers into the standalone share report", () => {
    const record = pointer();
    const images = share([BEFORE, AFTER]);
    const html = renderEvidenceHtml(manifest(), [record], new Set(images.hashes.keys()), images);
    const plain = renderEvidenceHtml(manifest(), [unmarked(record)], new Set(images.hashes.keys()), images);
    expect(count(html, "pointer pointer-ring")).toBe(4);
    expect(html).toContain('<span class="image-frame" style="--w:1280;--h:800"><img data-img="h0"');
    expect(html).toContain('id="markers" checked');
    expect(cspOf(html)).toBe(cspOf(plain));
    expect(scriptOf(html)).toBe(scriptOf(plain));
  });
});
