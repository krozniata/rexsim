import type { Platform } from "../device";
import { cellHeight, cellWidth } from "../terminal/term";
import type { App } from "./app";
import { captionRows, gapCols } from "./layout";
import type { Phone } from "./phone";
import { cornerRadius } from "./frames";
import { capsule, roundedOutline, rgbOf } from "./shapes";
import { drawSidebar, panelCol } from "./sidebar";
import { sgr } from "./theme";

export const width = (s: string) => [...s].length;

export function clip(s: string, n: number): string {
  if (n <= 0) return "";
  const r = [...s];
  if (r.length <= n) return s;
  return r.slice(0, Math.max(0, n - 1)).join("") + "…";
}

export function drawChrome(a: App): void {
  const s = a.size;
  if (s.rows < 4 || s.cols < 20 || !a.focus) return;
  a.beginSync();
  drawHeader(a);
  for (const p of a.visible()) drawFrame(a, p);
  if (a.sidebar) drawSidebar(a, a.sidebar, panelCol(a), panelCol(a));
  drawFooter(a);
  a.t.write("\x1b[0m");
  a.endSync();
}

function drawHeader(a: App): void {
  a.t.write(`\x1b[1;1H\x1b[0m\x1b[2K ${sgr(a.pal.accent, "1")}◆ rexsim`);
}

export function platformAccent(a: App, platform: Platform): string {
  return platform === "android" ? a.pal.android : a.pal.accent;
}

export function phoneAccent(a: App, p: Phone): string {
  return platformAccent(a, p.device.platform);
}

// drawFrame draws the phone's border, in its accent colour when it has the
// keyboard among others in the grid, and below it its name over its OS or
// state. While one phone fills the pane its size already says so. Each caption line
// clears only its own width, since a thumbnail can sit to its right.
function drawFrame(a: App, p: Phone): void {
  const f = p.frame;
  if (f.cols < 3) return;
  const focused = p === a.focus && !a.solo && a.visible().length > 1;
  drawBorder(a, p, focused);

  const bottom = f.row + f.rows - 1 - captionRows;
  const room = f.cols + gapCols - 1;
  const name = p.device.name;
  let detail: string;
  let nameStyle = sgr(a.pal.text, "1");
  if (p.state.kind === "failed") {
    detail = p.state.reason;
    nameStyle = sgr(a.pal.err, "1");
  } else if (p.state.kind === "connecting") {
    detail = p.device.booted ? "connecting…" : "booting…";
  } else {
    detail = p.state.session.os;
    if (focused) nameStyle = sgr(phoneAccent(a, p), "1");
  }
  const left = Math.max(0, f.col - gapCols / 2 + 1);
  const clear = " ".repeat(Math.max(0, Math.min(room, a.size.cols - left)));
  const line = (row: number, text: string, style: string) => {
    text = clip(text, room);
    const start = Math.max(f.col + Math.trunc((f.cols - width(text)) / 2), left);
    a.t.write(`\x1b[${row};${left + 1}H\x1b[0m${clear}\x1b[${row};${start + 1}H${style}${text}\x1b[0m`);
  };
  line(bottom + 2, name, nameStyle);
  line(bottom + 3, detail, sgr(a.pal.dim));
}

// drawBorder draws a rounded outline around the phone as an image, because
// box-drawing characters can't round a corner by more than a cell. The
// outline sits a uniform gap outside the screen, and its radius is the
// screen's plus that gap, so the corners stay concentric. It sits above the
// frame, whose corners are filled in, and never overlaps the screen itself.
// A pill on the outline marks the device's top, as an earpiece would. The
// border is redrawn only when its look changes.
function drawBorder(a: App, p: Phone, focused: boolean): void {
  const color = focused ? phoneAccent(a, p) : a.pal.frame;
  const side = p.session?.top ?? 0;
  const key = JSON.stringify(p.frame) + color + side;
  if (key === p.borderKey) return;
  p.borderKey = key;

  const cw = cellWidth(a.size);
  const ch = cellHeight(a.size);
  const f = p.frame;
  const rows = f.rows - captionRows;
  const w = Math.round(f.cols * cw);
  const h = Math.round(rows * ch);
  const gap = 0.5 * Math.min(cw, ch);
  const stroke = Math.max(1.5, Math.round(Math.min(cw, ch) / 8));
  const b = p.box;
  const left = b.x - f.x - gap;
  const top = b.y - f.y - gap;
  const right = left + b.w + 2 * gap;
  const bottom = top + b.h + 2 * gap;
  const r = cornerRadius(b.w, b.h, p.device.platform) + gap;
  const pix = roundedOutline(w, h, left, top, right, bottom, r, stroke, rgbOf(color));
  drawEarpiece(pix, w, h, left, top, right, bottom, side, stroke, rgbOf(color));
  const img = { pix, format: 32, width: w, height: h };
  try {
    p.border.draw(a.t, img, f.col, f.row, f.cols, rows, 1);
  } catch (err) {
    a.flash((err as Error).message);
  }
}

// drawEarpiece draws the pill on the outline's edge at side, in quarter
// turns clockwise from the top, a fifth as long as that edge and thick
// enough to stand out from the line without reaching the screen.
function drawEarpiece(
  pix: Uint8Array, w: number, h: number, left: number, top: number, right: number, bottom: number,
  side: number, stroke: number, color: [number, number, number],
): void {
  const thick = stroke * 2.5;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  if (side % 2 === 0) {
    const y = side === 0 ? top : bottom;
    const half = (right - left) / 10;
    capsule(pix, w, h, cx - half, y, cx + half, y, thick, color);
  } else {
    const x = side === 1 ? right : left;
    const half = (bottom - top) / 10;
    capsule(pix, w, h, x, cy - half, x, cy + half, thick, color);
  }
}

// drawFooter shows the shortcuts that act on the device, then those that
// act on rexsim. A status message takes their place for a moment.
function drawFooter(a: App): void {
  a.t.write(`\x1b[${a.size.rows};1H\x1b[0m\x1b[2K `);
  const room = a.size.cols - 2;
  if (Date.now() < a.statusUntil) a.t.write(sgr(a.pal.accent) + clip(a.status, room));
  else drawHints(a, room, hintGroups(a));
}

type Hint = [key: string, label: string];

// hintGroups lists the shortcuts that act on the device, then those that
// act on rexsim itself.
function hintGroups(a: App): Hint[][] {
  if (a.sidebar) return [[["↑↓", "move"], ["space", "show or hide"], ["esc", "close"]]];
  const device: Hint[] = [["⌃B", "home"], ["⌃R", "rotate"], ["⌃S", "screenshot"]];
  if (a.focus?.device.platform === "android") device.splice(1, 0, ["esc", "back"]);
  let rexsim: Hint[] = [["⌃F", "focus"], ["⌃N", "next"], ["⌃O", "devices"]];
  if (a.phones.length < 2) rexsim = rexsim.slice(2);
  return [device, rexsim];
}

// drawHints writes the groups with a divider between them, as many hints as
// fit in room columns.
function drawHints(a: App, room: number, groups: Hint[][]): void {
  let used = 0;
  for (const [i, group] of groups.entries()) {
    if (i > 0) {
      if (used + 3 > room) return;
      a.t.write(`${sgr(a.pal.frame)}│  `);
      used += 3;
    }
    for (const [key, label] of group) {
      const n = width(key) + 1 + width(label) + 3;
      if (used + n > room) return;
      a.t.write(`${sgr(a.pal.text, "1")}${key} ${sgr(a.pal.dim)}${label}   `);
      used += n;
    }
  }
}
