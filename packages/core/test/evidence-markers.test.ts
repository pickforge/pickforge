import { describe, expect, it } from "vitest";
import {
  GLYPH_COLOR,
  GLYPH_DASH,
  GLYPH_HALO_COLOR,
  GLYPH_HALO_WIDTH,
  GLYPH_STROKE_WIDTH,
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

type Size = { width: number; height: number };
const SCREEN: Size = { width: 1280, height: 800 };

function artifactPaths(records: readonly EvidenceRecord[]): string[] {
  return records.flatMap((record) => ("artifacts" in record ? record.artifacts ?? [] : []));
}

function sizes(paths: readonly string[], size: Size = SCREEN): Map<string, Size> {
  return new Map(paths.map((relative) => [relative, size]));
}

function render(records: readonly EvidenceRecord[], size: Size = SCREEN): string {
  const paths = artifactPaths(records);
  return renderEvidenceHtml(manifest(), records, new Set(paths), undefined, sizes(paths, size));
}

function renderUnsized(records: readonly EvidenceRecord[]): string {
  return renderEvidenceHtml(manifest(), records, new Set(artifactPaths(records)));
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

const SVG = 'aria-hidden="true" focusable="false"';
const RING = '<circle class="s" r="7"/>';

function anchored(x: string, y: string, side: number, body: string): string {
  const half = side / 2;
  return `<svg class="pointer glyph glyph-at" style="--x:${x};--y:${y}" width="${side}" height="${side}" viewBox="-${half} -${half} ${side} ${side}" ${SVG}>${body}</svg>`;
}

function area(body: string, width = 1280, height = 800): string {
  return `<svg class="pointer glyph glyph-area" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" ${SVG}>${body}</svg>`;
}

const CENTRE_RING = anchored("50.0391%", "50.0625%", 18, '<circle class="h" r="7"/><circle class="s" r="7"/>');
const CENTRE_DOT = anchored("50.0391%", "50.0625%", 10, '<circle class="hf" r="3"/><circle class="f" r="3"/>');

/** One record per kind, each with its own before and after captures. */
function everyKind(): EvidenceAction[] {
  const kinds: Array<[string, Record<string, unknown>]> = [
    ["desktop_click", { x: 100, y: 120 }],
    ["desktop_double_click", { x: 300, y: 220 }],
    ["desktop_drag", { fromX: 10, fromY: 20, x: 700, y: 500 }],
    ["desktop_scroll", { x: 900, y: 600, wheelX: -1, wheelY: 3 }],
    ["desktop_type", { length: 9, inputType: "text", focus: { x: -40, y: 100, width: 600, height: 400 } }],
  ];
  return kinds.map(([tool, target], index) => pointer({
    actionId: `act-${index}`, tool, startedAt: `2026-10-03T12:00:0${index}.000Z`,
    target: { ...target, coordinateSpace: "xvfb-root" },
    artifacts: [`screenshots/k${index}-before.png`, `screenshots/k${index}-after.png`],
    captures: [
      { path: `screenshots/k${index}-before.png`, phase: "before", width: 1280, height: 800 },
      { path: `screenshots/k${index}-after.png`, phase: "after", width: 1280, height: 800 },
    ],
  }));
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
    expect(count(html, CENTRE_RING)).toBe(4);
    // Only the after capture shows the result dot, in the gallery and in its inspect view.
    expect(count(html, CENTRE_DOT)).toBe(2);
    expect(html).toContain(`<img src="${AFTER}" alt="Capture for step 1, mcp / desktop_click" loading="lazy">${CENTRE_RING}${CENTRE_DOT}</span>`);
    expect(count(html, '<span class="image-frame" style="--w:1280;--h:800">')).toBe(4);
    expect(count(html, '<span class="stage framed">')).toBe(2);
    expect(count(html, '<div class="inspect-stage framed">')).toBe(2);
    expect(html).toContain(`<span class="image-frame" style="--w:1280;--h:800"><img src="${BEFORE}"`);
    expect(count(html, '<span class="mono">Pointer: click at 640, 400 · before · completed</span>')).toBe(1);
    expect(count(html, '<span class="mono">Pointer: click at 640, 400 · after · completed</span>')).toBe(1);
    expect(count(html, '<span class="pointer-note">Pointer: click at 640, 400 · before · completed</span>')).toBe(1);
    expect(html).not.toContain('glyph glyph-area"');
    expect(html).not.toContain("image-frame attempted");
  });

  it("draws a dashed drag line from start to destination for attempted input", () => {
    const html = render([pointer({
      tool: "desktop_drag", inputState: "attempted",
      target: { fromX: 10, fromY: 20, x: 640, y: 400, coordinateSpace: "xvfb-root" },
    })]);
    expect(count(html, '<span class="image-frame attempted" style="--w:1280;--h:800">')).toBe(4);
    expect(count(html, area('<line class="h d" x1="10.5" y1="20.5" x2="640.5" y2="400.5"/><line class="s d" x1="10.5" y1="20.5" x2="640.5" y2="400.5"/>'))).toBe(4);
    const dashedRing = '<circle class="h d" r="7"/><circle class="s d" r="7"/>';
    // Intent rings the press point and points at the destination.
    expect(count(html, anchored("0.8203%", "2.5625%", 18, dashedRing))).toBe(2);
    expect(count(html, anchored("50.0391%", "50.0625%", 26, '<polygon class="hf" points="1.7126,1.033 -8.3183,0.2379 -3.6698,-7.4688"/><polygon class="f" points="1.7126,1.033 -8.3183,0.2379 -3.6698,-7.4688"/>'))).toBe(2);
    // The result dots both ends and rings the destination.
    expect(count(html, anchored("0.8203%", "2.5625%", 10, '<circle class="hf" r="3"/><circle class="f" r="3"/>'))).toBe(2);
    expect(count(html, anchored("50.0391%", "50.0625%", 18, dashedRing))).toBe(2);
    expect(count(html, CENTRE_DOT)).toBe(2);
    expect(html).toContain("Pointer: drag 10, 20 → 640, 400 · after · attempted");
    expect(html).toContain(".glyph .d{stroke-dasharray:6 4;stroke-linecap:butt}");
  });

  it("places points at pixel centres across the whole image", () => {
    const corner = (x: number, y: number) => render([pointer({
      target: { x, y, coordinateSpace: "xvfb-root" },
      captures: [{ path: BEFORE, phase: "before", width: 200, height: 120 }],
    })], { width: 200, height: 120 });
    expect(corner(0, 0)).toContain('style="--x:0.25%;--y:0.4167%"');
    expect(corner(199, 119)).toContain('style="--x:99.75%;--y:99.5833%"');
    expect(corner(199, 119)).toContain('style="--w:200;--h:120"');
  });

  it("only marks the captures the action links to", () => {
    const html = render([pointer({ captures: [{ path: AFTER, phase: "after", width: 1280, height: 800 }] })]);
    expect(html).toContain(`<span class="stage"><img src="${BEFORE}"`);
    expect(html).toContain(`<span class="stage framed"><span class="image-frame" style="--w:1280;--h:800"><img src="${AFTER}"`);
    expect(count(html, RING)).toBe(2);
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
    ["a drag without a start point", { tool: "desktop_drag" }],
    ["a link to a path outside the artifacts", { artifacts: [AFTER], captures: [{ path: BEFORE, phase: "before", width: 1280, height: 800 }] }],
    ["a capture with a zero size", { captures: [{ path: BEFORE, phase: "before", width: 0, height: 800 }] }],
    ["a pointer move", { tool: "desktop_move" }],
    ["an unknown tool", { tool: "desktop_screenshot" }],
    ["typing without a focused window", { tool: "desktop_type", target: { length: 4, inputType: "text", coordinateSpace: "xvfb-root" } }],
    ["typing into a window outside the capture", { tool: "desktop_type", target: { focus: { x: 1280, y: 0, width: 10, height: 10 }, coordinateSpace: "xvfb-root" } }],
    ["a scroll without a point", { tool: "desktop_scroll", target: { wheelX: 0, wheelY: 2 } }],
  ])("renders %s exactly as an unmarked record", (_label, change) => {
    const record = pointer(change);
    const html = render([record]);
    expect(html).toBe(render([unmarked(record)]));
    for (const text of ['class="pointer', "Pointer:", 'id="markers"', "image-frame", "framed", "container-type"]) {
      expect(html).not.toContain(text);
    }
  });

  it.each<[string, Size]>([
    ["a cropped PNG", { width: 1279, height: 800 }],
    ["a shorter PNG", { width: 1280, height: 799 }],
    ["a larger PNG", { width: 2560, height: 1600 }],
  ])("renders a link that disagrees with %s exactly as an unmarked record", (_label, size) => {
    const html = render([pointer()], size);
    expect(html).toBe(render([unmarked(pointer())], size));
    expect(html).not.toContain("image-frame");
  });

  it("renders unmarked without the actual PNG sizes", () => {
    const html = renderUnsized([pointer()]);
    expect(html).toBe(renderUnsized([unmarked(pointer())]));
    expect(html).not.toContain('class="pointer');
    const partial = renderEvidenceHtml(manifest(), [pointer()], new Set([BEFORE, AFTER]), undefined, sizes([AFTER]));
    expect(count(partial, RING)).toBe(2);
    expect(partial).toContain(`<span class="stage"><img src="${BEFORE}"`);
  });

  it.each<[string, (other: EvidenceAction) => EvidenceAction]>([
    ["artifacts", (other) => ({ ...other, artifacts: [AFTER] })],
    ["capture links", (other) => ({ ...other, captures: [{ path: AFTER, phase: "after", width: 1280, height: 800 }] })],
  ])("suppresses markers on a capture another record claims in its %s", (_label, claim) => {
    const other: EvidenceAction = {
      actionId: "act-2", source: "mcp", tool: "desktop_screenshot", startedAt: "2026-10-03T12:00:01.000Z", status: "ok",
    };
    const html = render([pointer(), claim(other)]);
    expect(count(html, RING)).toBe(2);
    expect(html).toContain(`<span class="stage framed"><span class="image-frame" style="--w:1280;--h:800"><img src="${BEFORE}"`);
    expect(html).toContain(`<span class="stage"><img src="${AFTER}"`);
    const both = [pointer(), claim(pointer({ actionId: "act-2", startedAt: "2026-10-03T12:00:01.000Z" }))];
    expect(render(both)).toBe(render(both.map(unmarked)));
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
    const records = everyKind();
    const html = render(records);
    expect(html).toBe(render(records));
    expect(cspOf(html)).toBe(reportContentSecurityPolicy());
    expect(scriptOf(html)).toBe(scriptOf(render([])));
    expect(count(html, "<script")).toBe(1);
    expect(html).not.toMatch(/https?:|url\(/);
    // Labels name only the kind and coordinates, so a hostile tool name never gets one.
    const hostile = render([pointer({ tool: 'desktop_<img src=x onerror=alert(1)>' })]);
    expect(hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(hostile).not.toContain("<img src=x");
    expect(hostile).not.toContain('class="pointer');
  });

  it("carries markers into the standalone share report", () => {
    const record = pointer();
    const images = share([BEFORE, AFTER]);
    const actual = sizes([BEFORE, AFTER]);
    const html = renderEvidenceHtml(manifest(), [record], new Set(images.hashes.keys()), images, actual);
    const plain = renderEvidenceHtml(manifest(), [unmarked(record)], new Set(images.hashes.keys()), images, actual);
    expect(count(html, RING)).toBe(4);
    expect(html).toContain('<span class="image-frame" style="--w:1280;--h:800"><img data-img="h0"');
    expect(html).toContain('id="markers" checked');
    expect(cspOf(html)).toBe(cspOf(plain));
    expect(scriptOf(html)).toBe(scriptOf(plain));
  });
});

describe("evidence report glyph parts", () => {
  it("draws scroll direction, the focused window and the caret", () => {
    const html = render(everyKind());
    const ring = '<circle class="h" r="7"/><circle class="s" r="7"/>';
    // Scroll up-left 1, down 3: the arrow sits clear of the ring.
    expect(count(html, anchored("70.3516%", "75.0625%", 66, '<polygon class="hf" points="-6.957,20.871 -8.38,10.9099 0.1581,13.7559"/><polygon class="f" points="-6.957,20.871 -8.38,10.9099 0.1581,13.7559"/>'))).toBe(4);
    expect(count(html, anchored("70.3516%", "75.0625%", 18, ring))).toBe(4);
    expect(html).toContain("Pointer: scroll down 3 and left 1 at 900, 600 · before · completed");
    // The window keeps its root rect; the caret centres on its visible part.
    expect(count(html, area('<rect class="h" x="-40" y="100" width="600" height="400"/><rect class="s" x="-40" y="100" width="600" height="400"/>'))).toBe(4);
    expect(count(html, anchored("21.875%", "37.5%", 20, '<path class="h" d="M-4 -8H4M0 -8V8M-4 8H4"/><path class="s" d="M-4 -8H4M0 -8V8M-4 8H4"/>'))).toBe(4);
    expect(count(html, anchored("21.875%", "37.5%", 10, '<circle class="hf" r="3"/><circle class="f" r="3"/>'))).toBe(2);
    expect(html).toContain("Keyboard: type into the focused window · after · completed");
    expect(count(html, anchored("23.4766%", "27.5625%", 18, ring) + anchored("23.4766%", "27.5625%", 28, '<circle class="h" r="12"/><circle class="s" r="12"/>'))).toBe(4);
  });

  it("styles parts with the shared glyph constants and clips them to the image", () => {
    const html = render([pointer()]);
    expect(html).toContain(`.glyph .h{stroke:${GLYPH_HALO_COLOR};stroke-width:${GLYPH_HALO_WIDTH}px}`);
    expect(html).toContain(`.glyph .s{stroke:${GLYPH_COLOR};stroke-width:${GLYPH_STROKE_WIDTH}px}`);
    expect(html).toContain(`.glyph .d{stroke-dasharray:${GLYPH_DASH[0]} ${GLYPH_DASH[1]};stroke-linecap:butt}`);
    expect(html).toContain(`.glyph .hf{fill:${GLYPH_HALO_COLOR};stroke:${GLYPH_HALO_COLOR};stroke-width:${GLYPH_HALO_WIDTH - GLYPH_STROKE_WIDTH}px;stroke-linejoin:round}`);
    expect(html).toContain(`.glyph .f{fill:${GLYPH_COLOR}}`);
    expect(html).toContain(".glyph-area *{vector-effect:non-scaling-stroke}");
    expect(html).toContain(".image-frame{position:relative;display:block;flex:none;overflow:hidden;");
    expect(html).toContain("#markers:not(:checked)~.shell .pointer,#markers:not(:checked)~.inspect .pointer{display:none}");
  });

  it("marks every part as decoration under the overlay switch", () => {
    const html = render(everyKind());
    const parts = html.match(/<svg class="[^"]*glyph[^"]*"[^>]*>/g) ?? [];
    expect(parts.length).toBeGreaterThan(40);
    for (const part of parts) {
      expect(part).toMatch(/^<svg class="pointer glyph /);
      expect(part).toContain(SVG);
    }
  });

  it("anchors parts within 0.05 image px of the recorded points", () => {
    const sizes: Size[] = [{ width: 1280, height: 800 }, { width: 1366, height: 768 }, { width: 333, height: 777 }];
    for (const size of sizes) {
      for (const [x, y] of [[0, 0], [size.width - 1, size.height - 1], [Math.floor(size.width / 3), Math.floor(size.height * 2 / 3)]]) {
        const html = render([pointer({
          tool: "desktop_drag", target: { fromX: size.width - 1 - x, fromY: y, x, y, coordinateSpace: "xvfb-root" },
          captures: [{ path: BEFORE, phase: "before", width: size.width, height: size.height }],
        })], size);
        const anchors = [...html.matchAll(/--x:([\d.]+)%;--y:([\d.]+)%/g)].map((match) => [
          Number(match[1]) / 100 * size.width, Number(match[2]) / 100 * size.height,
        ]);
        expect(anchors.length).toBe(4);
        const [from, to] = [[size.width - 1 - x + 0.5, y + 0.5], [x + 0.5, y + 0.5]];
        for (const [index, point] of [[0, from], [1, to], [2, from], [3, to]] as const) {
          expect(Math.abs(anchors[index]![0]! - point[0]!)).toBeLessThan(0.05);
          expect(Math.abs(anchors[index]![1]! - point[1]!)).toBeLessThan(0.05);
        }
        expect(html).toContain(`x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}"`);
      }
    }
  });
});
