import type { Device } from "../device";
import { devices as listDevices } from "../platforms";
import type { Key, Mouse } from "../terminal/input";
import { cellHeight, cellWidth } from "../terminal/term";
import { animate } from "./animate";
import type { App } from "./app";
import { clip, drawChrome, phoneAccent, platformAccent, width } from "./chrome";
import { entryOf, groupEntries, platformName, scrollTo } from "./groups";
import { footerRows } from "./layout";
import type { Phone } from "./phone";
import { sgr } from "./theme";

const sidebarCols = 34;
const listTop = 4;

// Sidebar lists every simulator and emulator beside the phones, to show or
// hide them.
export type Sidebar = { devices: Device[]; sel: number; offset: number };

// panelCol is the column where the sidebar starts, or the pane's width when
// it is closed.
export function panelCol(a: App): number {
  return a.sidebar ? Math.max(0, a.size.cols - sidebarCols) : a.size.cols;
}

// toggleSidebar slides the device list in from the right, with the device
// whose id is select selected, or back out.
export async function toggleSidebar(a: App, select = ""): Promise<void> {
  if (a.sidebar) {
    await animate(a, () => {
      a.sidebar = null;
    });
    return;
  }
  let devices: Device[];
  try {
    devices = await listDevices(a.signal);
  } catch (err) {
    a.flash((err as Error).message);
    return;
  }
  await animate(a, () => {
    a.sidebar = { devices, sel: Math.max(0, devices.findIndex((d) => d.id === select)), offset: 0 };
  });
}

function phoneFor(a: App, id: string): Phone | null {
  return a.phones.find((p) => p.device.id === id) ?? null;
}

// toggleDevice shows the selected device, booting it if needed, restarts
// it if it stopped, or hides it and shuts it down, and slides the list away
// unless no device is left. Only one device starts at a time.
async function toggleDevice(a: App): Promise<void> {
  const sb = a.sidebar!;
  if (sb.devices.length === 0) return;
  const d = sb.devices[sb.sel];
  const p = phoneFor(a, d.id);
  if (p && p.state.kind !== "failed") {
    await animate(a, () => {
      a.removePhone(p);
      if (a.phones.length > 0) a.sidebar = null;
    });
    return;
  }
  const starting = a.phones.find((q) => q.state.kind === "connecting");
  if (starting) {
    a.flash(`Wait for ${starting.device.name} to start`);
    return;
  }
  await animate(a, () => {
    a.focus = p ? a.restart(p) : a.add([d])[0];
    a.sidebar = null;
  });
}

// markShutDown keeps the list's state in step when a phone closes.
export function markShutDown(a: App, id: string): void {
  for (const d of a.sidebar?.devices ?? []) if (d.id === id) d.booted = false;
}

// sidebarKey handles a key while the list is open and reports whether it
// did. The list takes the arrows, Space, Enter and typing, so they don't
// reach a phone by surprise; other shortcuts still work.
export async function sidebarKey(a: App, k: Key): Promise<boolean> {
  const sb = a.sidebar!;
  if (k.name === "up" || k.rune === "k") {
    sb.sel = Math.max(0, sb.sel - 1);
  } else if (k.name === "down" || k.rune === "j") {
    sb.sel = Math.max(0, Math.min(sb.devices.length - 1, sb.sel + 1));
  } else if (k.name === "enter" || k.rune === " ") {
    await toggleDevice(a);
    return true;
  } else if (k.name === "esc" || k.name === "ctrl+o") {
    await toggleSidebar(a);
    return true;
  } else if (k.name.startsWith("ctrl+")) {
    return false;
  } else {
    return true;
  }
  drawChrome(a);
  return true;
}

// sidebarMouse handles clicks and the wheel over the list and reports
// whether it did. Movement and releases pass through, so a drag that started
// on a phone still lifts its finger when it ends over the list.
export async function sidebarMouse(a: App, m: Mouse): Promise<boolean> {
  if (!a.sidebar || m.motion || m.release || Math.trunc(m.x / cellWidth(a.size)) < panelCol(a)) return false;
  const sb = a.sidebar;
  if (m.button === 64) {
    sb.sel = Math.max(0, sb.sel - 1);
    drawChrome(a);
  } else if (m.button === 65) {
    sb.sel = Math.max(0, Math.min(sb.devices.length - 1, sb.sel + 1));
    drawChrome(a);
  } else if (m.button === 0) {
    const row = Math.trunc(m.y / cellHeight(a.size));
    const e = groupEntries(sb.devices)[sb.offset + Math.trunc((row - listTop) / 2)];
    if (row >= listTop && e?.kind === "device") {
      sb.sel = e.i;
      await toggleDevice(a);
    }
  }
  return true;
}

type Segment = [text: string, style: string];

// drawSidebar draws the list with its left edge at col, clipped to the pane,
// after clearing each row from clearFrom, so it can slide in steps.
export function drawSidebar(a: App, sb: Sidebar | null, col: number, clearFrom: number): void {
  const s = a.size;
  for (let row = 1; row < s.rows - footerRows; row++) a.t.write(`\x1b[${row + 1};${clearFrom + 1}H\x1b[0m\x1b[K`);
  if (!sb || col >= s.cols) return;
  const room = s.cols - col;
  const inner = room - 2;
  const edge: Segment = ["│ ", sgr(a.pal.frame)];
  const line = (row: number, ...segs: Segment[]) => {
    a.t.write(`\x1b[${row + 1};${col + 1}H`);
    let left = room;
    for (const [text, style] of segs) {
      const shown = width(text) > left ? [...text].slice(0, left).join("") : text;
      a.t.write(style + shown);
      left -= width(shown);
    }
    a.t.write("\x1b[0m");
  };
  for (let row = 1; row < s.rows - footerRows; row++) line(row, edge);
  line(2, edge, ["Devices", sgr(a.pal.text, "1")], [`  ${sb.devices.length}`, sgr(a.pal.dim)]);

  // Every entry takes two rows; a header sits on the lower one, so a blank
  // row separates it from the group above.
  const list = groupEntries(sb.devices);
  const visible = Math.max(1, Math.trunc((s.rows - footerRows - listTop) / 2));
  sb.offset = scrollTo(list, entryOf(list, sb.sel), sb.offset, visible);
  for (let k = sb.offset; k < list.length && k < sb.offset + visible; k++) {
    const e = list[k];
    const r = listTop + (k - sb.offset) * 2;
    if (e.kind === "header") {
      line(r + 1, edge, [platformName[e.platform], sgr(platformAccent(a, e.platform), "1")], [`  ${e.count}`, sgr(a.pal.dim)]);
    }
    if (e.kind !== "device") continue;
    const i = e.i;
    const d = sb.devices[i];
    const bg = i === sb.sel ? [a.pal.chip] : [];
    const style = (...params: string[]) => sgr(...bg, ...params);
    let mark = "○ ";
    let markStyle = style(a.pal.dim);
    const shown = phoneFor(a, d.id);
    if (shown) {
      mark = "● ";
      markStyle = style(phoneAccent(a, shown));
    } else if (d.booted) {
      mark = "● ";
    }
    line(r, edge, [mark, markStyle], [fit(d.name, inner - 2), style(a.pal.text, "1")]);
    line(r + 1, edge, ["  ", style()], [fit(d.runtime, inner - 2), style(a.pal.dim)]);
  }
}

// fit clips or pads s to exactly n columns.
function fit(s: string, n: number): string {
  if (n <= 0) return "";
  s = clip(s, n);
  return s + " ".repeat(n - width(s));
}
