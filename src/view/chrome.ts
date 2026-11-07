import type { Platform } from "../device";
import { cellHeight, cellWidth } from "../terminal/term";
import type { App } from "./app";
import { captionRows, gapCols } from "./layout";
import type { Phone } from "./phone";
import { roundedOutline, rgbOf, screenRadius } from "./shapes";
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
  const n = a.phones.length;
  if (a.solo && n > 1) a.t.write(`${sgr(a.pal.dim)}  ${a.focusIndex() + 1} of ${n} · focus`);
  else if (n > 1) a.t.write(`${sgr(a.pal.dim)}  ${n} devices`);
}

export function platformAccent(a: App, platform: Platform): string {
  return platform === "android" ? a.pal.android : a.pal.accent;
}

export function phoneAccent(a: App, p: Phone): string {
  return platformAccent(a, p.device.platform);
}

// drawFrame draws the phone's border, in its accent colour when it has the
// keyboard, and its caption below.
function drawFrame(a: App, p: Phone): void {
  const f = p.frame;
  if (f.cols < 3) return;
  const focused = p === a.focus && a.visible().length > 1;
  drawBorder(a, p, focused);

  const bottom = f.row + f.rows - 1 - captionRows;
  const room = f.cols + gapCols - 1;
  let name = p.device.name;
  let detail: string;
  let nameStyle = sgr(a.pal.text, "1");
  if (p.state.kind === "failed") {
    detail = "  " + p.state.reason;
    nameStyle = sgr(a.pal.err, "1");
  } else if (p.state.kind === "connecting") {
    detail = p.device.booted ? "  connecting…" : "  booting…";
  } else {
    detail = "  " + p.state.session.os;
    if (focused) nameStyle = sgr(phoneAccent(a, p), "1");
  }
  name = clip(name, room);
  detail = clip(detail, room - width(name));
  let start = f.col + Math.trunc((f.cols - width(name) - width(detail)) / 2);
  start = Math.max(start, f.col - gapCols / 2 + 1, 0);
  a.t.write(`\x1b[${bottom + 2};${start + 1}H\x1b[0K${nameStyle}${name}${sgr(a.pal.dim)}${detail}\x1b[0m`);
}

// drawBorder draws a rounded outline around the phone as an image, because
// box-drawing characters can't round a corner by more than a cell. The
// outline sits a uniform gap outside the screen, and its radius is the
// screen's plus that gap, so the corners stay concentric. It is redrawn only
// when its look changes.
function drawBorder(a: App, p: Phone, focused: boolean): void {
  const color = focused ? phoneAccent(a, p) : a.pal.frame;
  const key = JSON.stringify(p.frame) + color;
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
  const r = screenRadius(p.aspect(), p.device.platform) * b.w + gap;
  const img = { pix: roundedOutline(w, h, left, top, right, bottom, r, stroke, rgbOf(color)), format: 32, width: w, height: h };
  try {
    p.border.draw(a.t, img, f.col, f.row, f.cols, rows, -1);
  } catch (err) {
    a.flash((err as Error).message);
  }
}

// drawFooter shows the shortcuts that act on the device, then those that
// act on rexsim, with the frame rate at the end. A status message takes the
// place of the shortcuts for a moment.
function drawFooter(a: App): void {
  a.t.write(`\x1b[${a.size.rows};1H\x1b[0m\x1b[2K `);
  let rate = "○ idle ";
  let rateStyle = sgr(a.pal.dim);
  if (a.fps > 0) {
    rate = `● ${a.fps} fps `;
    rateStyle = sgr(a.pal.accent);
  }
  const room = a.size.cols - width(rate) - 2;
  if (Date.now() < a.statusUntil) a.t.write(sgr(a.pal.accent) + clip(a.status, room));
  else drawHints(a, room, hintGroups(a));
  a.t.write(`\x1b[${a.size.rows};${a.size.cols - width(rate) + 1}H${rateStyle}${rate}`);
}

type Hint = [key: string, label: string];

// hintGroups lists the shortcuts that act on the device, then those that
// act on rexsim itself.
function hintGroups(a: App): Hint[][] {
  if (a.sidebar) return [[["↑↓", "move"], ["space", "show or hide"], ["esc", "close"], ["⌃]", "quit"]]];
  const device: Hint[] = [["⌃B", "home"], ["⌃L", "lock"], ["⌃S", "screenshot"]];
  if (a.focus?.device.platform === "android") device.splice(1, 0, ["esc", "back"]);
  let rexsim: Hint[] = [["⌃F", "focus"], ["⌃N", "next"], ["⌃O", "devices"], ["⌃]", "quit"]];
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
