import { type Device, label as deviceLabel, resolve } from "../device";
import { devices as listDevices } from "../platforms";
import { cellHeight } from "../terminal/term";
import { type App, Quit } from "./app";
import { platformAccent, width } from "./chrome";
import { entryOf, groupEntries, platformName, scrollTo } from "./groups";
import { sgr } from "./theme";

export async function chooseDevices(a: App): Promise<Device[]> {
  const devices = await listDevices(a.signal);
  if (a.opts.ids.length > 0) return resolve(devices, a.opts.ids);
  if (devices.length === 0) {
    throw new Error("no simulators or emulators are available; add one in Xcode or Android Studio");
  }
  const booted = devices.filter((d) => d.booted);
  return booted.length > 0 ? booted : pick(a, devices);
}

// pick lists the simulators and emulators, grouped by platform, when none is
// booted. Space marks one or more and Enter shows them, or the selected one
// when none is marked; a digit, which counts the devices on screen, or a
// click shows only that one.
async function pick(a: App, devices: Device[]): Promise<Device[]> {
  const top = 5;
  const marked = devices.map(() => false);
  const labelWidth = Math.max(...devices.map((d) => width(deviceLabel(d))));
  const list = groupEntries(devices, true);
  let sel = 0;
  let offset = 0;
  for (;;) {
    const visible = Math.max(1, a.size.rows - top - 1);
    offset = scrollTo(list, entryOf(list, sel), offset, visible);
    const shown = list.slice(offset, offset + visible);
    a.t.write(`\x1b[0m\x1b[2J\x1b[2;3H${sgr(a.pal.accent, "1")}◆ rexsim${sgr(a.pal.dim)}  choose devices`);
    a.t.write(`\x1b[3;3H${sgr(a.pal.dim)}↑↓ move   space select   enter open   1–9 open one   q quit\x1b[0m`);
    for (const [n, e] of shown.entries()) {
      const row = top + n;
      if (e.kind === "header") {
        a.t.write(`\x1b[${row};3H${sgr(platformAccent(a, e.platform), "1")}${platformName[e.platform]}${sgr(a.pal.dim)}  ${e.count}\x1b[0m`);
      }
      if (e.kind !== "device") continue;
      const i = e.i;
      const lbl = deviceLabel(devices[i]);
      let mark = "○";
      let markStyle = sgr(a.pal.dim);
      if (marked[i]) {
        mark = "●";
        markStyle = sgr(platformAccent(a, devices[i].platform));
      }
      const label = lbl + " ".repeat(labelWidth - width(lbl));
      let text = sgr(a.pal.text);
      if (i === sel) {
        text = sgr(a.pal.chip, a.pal.chipText, "1");
        markStyle = markStyle.replace("\x1b[0;", `\x1b[0;${a.pal.chip};`);
      }
      a.t.write(`\x1b[${row};3H${markStyle} ${mark} ${text} ${label} \x1b[0m`);
    }
    a.t.flush();

    const ev = await a.events.next();
    if (ev.kind === "quit") throw new Quit();
    if (ev.kind === "winch") {
      a.updateSize();
      continue;
    }
    if (ev.kind === "key") {
      const onScreen = shown.flatMap((e) => (e.kind === "device" ? [e.i] : []));
      const digit = ev.rune >= "1" && ev.rune <= "9" ? (onScreen[Number(ev.rune) - 1] ?? -1) : -1;
      if (ev.name === "up" || ev.rune === "k") {
        sel = Math.max(0, sel - 1);
      } else if (ev.name === "down" || ev.rune === "j") {
        sel = Math.min(devices.length - 1, sel + 1);
      } else if (ev.rune === " ") {
        marked[sel] = !marked[sel];
      } else if (ev.name === "enter") {
        const chosen = devices.filter((_, i) => marked[i]);
        return chosen.length > 0 ? chosen : [devices[sel]];
      } else if (digit >= 0 && digit < devices.length) {
        return [devices[digit]];
      } else if (ev.rune === "q" || ["esc", "ctrl+c", "ctrl+]"].includes(ev.name)) {
        throw new Quit();
      }
    } else if (ev.kind === "mouse") {
      const row = Math.trunc(ev.y / cellHeight(a.size));
      if (ev.button === 0 && !ev.release && !ev.motion) {
        const e = row >= top - 1 ? shown[row - (top - 1)] : undefined;
        if (e?.kind === "device") return [devices[e.i]];
      } else if (ev.button === 64) {
        sel = Math.max(0, sel - 1);
      } else if (ev.button === 65) {
        sel = Math.min(devices.length - 1, sel + 1);
      }
    }
  }
}
