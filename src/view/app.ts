// Shows simulators in the terminal and sends the mouse and keyboard to them.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as companion from "../companion";
import { type Device, shutdown } from "../device";
import { type InputEvent, type Key, type Mouse, readEvents } from "../input";
import * as keys from "../keys";
import * as kitty from "../kitty";
import { cellWidth, type Size, Terminal } from "../term";
import { animate } from "./animate";
import { drawChrome } from "./chrome";
import { computeLayout, contains, emptyBox } from "./layout";
import { closeConnection, type Connection, dial, Phone, type ViewFrame } from "./phone";
import { chooseDevices } from "./picker";
import { Queue } from "./queue";
import { markShutDown, panelCol, type Sidebar, sidebarKey, sidebarMouse, toggleSidebar } from "./sidebar";
import { dark, light, luminance, type Palette, sgr } from "./theme";

export type Options = { ids: string[]; agent: string; fps: number };

export class Quit extends Error {}

export type AppEvent =
  | InputEvent
  | { kind: "ready" }
  | { kind: "failure"; p: Phone; err: Error }
  | { kind: "winch" }
  | { kind: "tick" }
  | { kind: "wheel" }
  | { kind: "dialed"; c: Connection }
  | { kind: "error"; text: string }
  | { kind: "quit" };

const statusTime = 4000;
const themeTimeout = 300;
const moveInterval = 12;
const wheelWindow = 100;
const wheelStep = 30;

const namedKeys: Record<string, number> = {
  enter: keys.KeyEnter, backspace: keys.KeyBackspace, tab: keys.KeyTab, esc: keys.KeyEscape,
  up: keys.KeyUp, down: keys.KeyDown, left: keys.KeyLeft, right: keys.KeyRight,
};

export async function run(opts: Options): Promise<void> {
  const t = Terminal.open();
  const a = new App(t, opts);
  const quit = () => a.abort.abort();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, quit);
  process.on("SIGWINCH", () => a.events.push({ kind: "winch" }));
  process.on("uncaughtException", (err) => {
    t.close();
    console.error("rexsim:", err);
    process.exit(1);
  });
  readEvents(process.stdin, (ev) => a.events.push(ev));
  let err: unknown;
  try {
    await a.run();
  } catch (e) {
    err = e;
  }
  if (err && !(err instanceof Quit) && !a.signal.aborted) await a.fatal(err);
  a.stopTimers();
  await Promise.all(a.phones.map((p) => p.close()));
  t.close();
  if (err instanceof Quit || a.signal.aborted) return;
  if (err) throw err;
}

export class App {
  readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  readonly events = new Queue<AppEvent>();
  size: Size = { cols: 0, rows: 0, width: 0, height: 0 };

  pal: Palette = dark;
  phones: Phone[] = [];
  focus: Phone | null = null;
  solo = false;
  private bin: Promise<string> | null = null;
  private added = 0;
  private syncs = 0;
  sidebar: Sidebar | null = null;
  private readyQueued = false;
  private tick: ReturnType<typeof setInterval> | undefined;

  private wheelPhone: Phone | null = null;
  private wheelDY = 0;
  private wheelX = 0;
  private wheelY = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | undefined;

  status = "";
  statusUntil = 0;
  drawn = 0;
  fps = 0;

  constructor(
    readonly t: Terminal,
    readonly opts: Options,
  ) {
    this.signal.addEventListener("abort", () => this.events.push({ kind: "quit" }));
  }

  async run(): Promise<void> {
    this.updateSize();
    this.t.enableInput();
    await this.detectTheme();
    this.message("Looking for simulators…");
    const devices = await chooseDevices(this);
    this.focus = this.add(devices)[0];
    this.updateSize();
    this.relayout();

    this.tick = setInterval(() => this.events.push({ kind: "tick" }), 1000);
    for (;;) {
      const ev = await this.events.next();
      switch (ev.kind) {
        case "quit":
          return;
        case "failure":
          this.streamFailed(ev.p, ev.err);
          break;
        case "ready":
          this.readyQueued = false;
          for (const p of this.phones) {
            const f = p.takeLatest();
            if (f) this.paint(p, f);
          }
          break;
        case "key":
        case "mouse":
        case "paste":
        case "osc":
          await this.handle(ev);
          break;
        case "winch":
          if (this.updateSize()) this.relayout();
          break;
        case "tick":
          this.fps = this.drawn;
          this.drawn = 0;
          if (this.sizeChanged()) this.relayout();
          else drawChrome(this);
          break;
        case "wheel":
          this.flushWheel();
          break;
        case "dialed":
          await this.dialDone(ev.c);
          break;
        case "error":
          this.flash(ev.text);
          break;
      }
    }
  }

  stopTimers(): void {
    clearInterval(this.tick);
    clearTimeout(this.wheelTimer);
  }

  // companionBin fetches idb_companion the first time a simulator needs it,
  // and again after a failed download.
  private companionBin(progress: (text: string) => void): Promise<string> {
    this.bin ??= companion.binary(this.signal, progress).catch((err) => {
      this.bin = null;
      throw err;
    });
    return this.bin;
  }

  // add shows a placeholder for each device at once and connects them in the
  // background, so the other phones stay usable while a device boots. Each
  // phone gets image ids no other phone has used, so a closed phone's images
  // can't be mistaken for a new one's.
  add(devices: Device[]): Phone[] {
    const phones = devices.map((d) => {
      const p = new Phone(d);
      p.cancelConnect = new AbortController();
      p.placer.base = this.added * 2;
      p.border.base = 1_000_000 + this.added * 2;
      this.added++;
      dial(AbortSignal.any([this.signal, p.cancelConnect.signal]), () => this.companionBin((text) => this.flash(text)), p, d).then((c) =>
        this.events.push({ kind: "dialed", c }),
      );
      return p;
    });
    this.phones.push(...phones);
    return phones;
  }

  // dialDone fills in a phone once its device has booted and answers, or
  // shows why it couldn't.
  private async dialDone(c: Connection): Promise<void> {
    const p = c.p;
    if (!this.phones.includes(p)) {
      await closeConnection(c);
      return;
    }
    p.connecting = false;
    p.cancelConnect = null;
    if (c.err) {
      p.failed = c.err.message;
    } else {
      p.session = c.session!;
      p.screen = c.session!.screen;
    }
    this.relayout();
  }

  // streamFailed keeps the other phones running when one stops, for example
  // because its simulator shut down.
  private streamFailed(failed: Phone, err: Error): void {
    failed.failed = err.message;
    if (this.phones.some((p) => p.failed === "")) {
      this.flash(`${failed.device.name}: ${failed.failed}`);
      return;
    }
    throw err;
  }

  updateSize(): boolean {
    try {
      this.size = this.t.size();
      return true;
    } catch {
      return false;
    }
  }

  // sizeChanged rereads the size and reports whether it moved. A new pane can
  // settle its pixel size without a SIGWINCH, so the tick checks too.
  private sizeChanged(): boolean {
    const old = this.size;
    return (
      this.updateSize() &&
      (old.cols !== this.size.cols || old.rows !== this.size.rows || old.width !== this.size.width || old.height !== this.size.height)
    );
  }

  // detectTheme asks the terminal for its background colour (OSC 11) and
  // picks the palette that suits it. A terminal that doesn't answer gets the
  // dark one.
  private async detectTheme(): Promise<void> {
    this.pal = dark;
    this.t.write("\x1b]11;?\x1b\\");
    this.t.flush();
    const deadline = Date.now() + themeTimeout;
    for (;;) {
      const ev = await this.events.next(deadline - Date.now());
      if (!ev || ev.kind === "quit") return;
      if (ev.kind === "osc" && ev.text.startsWith("11;")) {
        const l = luminance(ev.text.slice(3));
        if (l !== null && l > 0.5) this.pal = light;
        return;
      }
    }
  }

  // message fills the screen with one line of progress, before the phones show.
  message(text: string): void {
    this.t.write(`\x1b[0m\x1b[2J\x1b[2;3H${sgr(this.pal.accent, "1")}◆ rexsim\x1b[0m\x1b[4;3H${sgr(this.pal.dim)}${text}\x1b[0m`);
    this.t.flush();
  }

  // fatal shows an error and waits for a key, because Rex closes the pane
  // when rexsim exits and the error would vanish with it.
  async fatal(err: unknown): Promise<void> {
    const text = err instanceof Error ? err.message : String(err);
    kitty.clearAll(this.t);
    this.t.write(
      `\x1b[0m\x1b[2J\x1b[2;3H${sgr(this.pal.accent, "1")}◆ rexsim\x1b[0m\x1b[4;3H${sgr(this.pal.err)}${text}` +
        `\x1b[6;3H${sgr(this.pal.dim)}Press any key to close.\x1b[0m`,
    );
    this.t.flush();
    for (;;) {
      const ev = await this.events.next();
      if (ev.kind === "key" || ev.kind === "quit") return;
    }
  }

  // paint places a phone's frame. Each placement writes its own file, because
  // the terminal deletes a file once it has read it.
  paint(p: Phone, f: ViewFrame): void {
    p.current = f;
    if (f.width !== p.frameW || f.height !== p.frameH) {
      p.frameW = f.width;
      p.frameH = f.height;
      this.relayout();
      return;
    }
    if (p.box.cols === 0) return;
    let path: string;
    try {
      path = kitty.writeTemp(f.rgba);
    } catch (err) {
      this.flash((err as Error).message);
      return;
    }
    this.beginSync();
    p.placer.place(this.t, path, 32, f.width, f.height, p.box.col, p.box.row, p.box.cols, p.box.rows, 0);
    this.endSync();
    this.drawn++;
  }

  // visible lists the phones on screen: all of them, or only the focused one
  // while it fills the pane.
  visible(): Phone[] {
    return this.solo ? [this.focus!] : this.phones;
  }

  // phoneArea is the part of the pane the phones use: all of it, or what the
  // sidebar leaves.
  private phoneArea(): Size {
    const s = { ...this.size };
    if (this.sidebar) {
      s.cols = panelCol(this);
      s.width = Math.trunc(s.cols * cellWidth(this.size));
    }
    return s;
  }

  layout(): void {
    for (const p of this.phones) {
      p.frame = emptyBox;
      p.box = emptyBox;
    }
    const shown = this.visible();
    computeLayout(
      this.phoneArea(),
      shown.map((p) => p.aspect()),
    )?.forEach((pl, i) => {
      shown[i].frame = pl.frame;
      shown[i].box = pl.box;
    });
  }

  // relayout redraws everything for a new pane size or phone shape. Each
  // image replaces its own previous one rather than the screen being cleared
  // first, which would flash blank. It restarts the streams whose phones are
  // now drawn at another size, and stops those of hidden phones until they
  // show again.
  relayout(): void {
    this.beginSync();
    try {
      for (const p of this.phones) p.borderKey = "";
      this.t.write("\x1b[0m\x1b[2J");
      this.layout();
      drawChrome(this);
      for (const p of this.phones) {
        if (p.box.cols === 0) {
          p.placer.delete(this.t);
          p.border.delete(this.t);
          p.pauseStream();
          continue;
        }
        const s = p.wantScale();
        if (s !== p.scale && p.failed === "" && !p.connecting) {
          p.scale = s;
          p.startStream(this.signal, this.opts.fps, () => this.queueReady(), (err) => this.events.push({ kind: "failure", p, err }));
        }
        if (p.current) this.paint(p, p.current);
      }
    } finally {
      this.endSync();
    }
  }

  private queueReady(): void {
    if (this.readyQueued) return;
    this.readyQueued = true;
    this.events.push({ kind: "ready" });
  }

  // beginSync and endSync bracket output that the terminal should show at
  // once (mode 2026). They nest, so a whole relayout lands as one update
  // rather than flashing blank between its parts.
  beginSync(): void {
    if (this.syncs === 0) this.t.write("\x1b[?2026h");
    this.syncs++;
  }

  endSync(): void {
    this.syncs--;
    if (this.syncs === 0) {
      this.t.write("\x1b[?2026l");
      this.t.flush();
    }
  }

  flash(text: string): void {
    this.status = text;
    this.statusUntil = Date.now() + statusTime;
    drawChrome(this);
  }

  // report shows a failed action in the footer once the main loop gets to it.
  report(action: Promise<unknown>): void {
    action.catch((err) => this.events.push({ kind: "error", text: (err as Error).message }));
  }

  private async handle(ev: InputEvent): Promise<void> {
    switch (ev.kind) {
      case "key":
        return this.key(ev);
      case "paste":
        if (!this.sidebar && this.usable(this.focus!)) this.report(this.focus!.session!.text(ev.text));
        return;
      case "mouse":
        return this.mouse(ev);
    }
  }

  // key sends typing to the phone clicked last.
  private async key(k: Key): Promise<void> {
    if (this.sidebar && (await sidebarKey(this, k))) return;
    switch (k.name) {
      case "ctrl+]":
      case "ctrl+c":
      case "ctrl+q":
        throw new Quit();
      case "ctrl+f":
        await this.toggleSolo();
        break;
      case "ctrl+n":
        this.focusNext();
        break;
      case "ctrl+o":
        await toggleSidebar(this);
        break;
    }
    const p = this.focus!;
    if (!this.usable(p)) return;
    const c = p.session!;
    switch (k.name) {
      case "ctrl+b":
        this.report(c.button("HOME"));
        break;
      case "ctrl+l":
        this.report(c.button("LOCK"));
        break;
      case "ctrl+s":
        await this.sendScreenshot(p);
        break;
      case "":
        this.report(c.text(k.rune));
        break;
      default: {
        const code = namedKeys[k.name];
        if (code !== undefined) this.report(c.key(code, false));
      }
    }
  }

  private phoneAt(px: number, py: number): Phone | null {
    return this.phones.find((p) => p.failed === "" && !p.connecting && contains(p.box, px, py)) ?? null;
  }

  private async mouse(m: Mouse): Promise<void> {
    if (await sidebarMouse(this, m)) return;
    if (m.button >= 64) {
      if (m.button > 65 || m.release || m.motion) return;
      const p = this.phoneAt(m.x, m.y);
      if (!p) return;
      if (p !== this.wheelPhone && this.wheelPhone) this.flushWheel();
      this.wheelPhone = p;
      this.wheelDY += m.button === 64 ? 1 : -1;
      [this.wheelX, this.wheelY] = p.point(m.x, m.y);
      this.wheelTimer ??= setTimeout(() => this.events.push({ kind: "wheel" }), wheelWindow);
    } else if (m.button === 0 && !m.motion && !m.release) {
      const p = this.phoneAt(m.x, m.y);
      if (!p) {
        for (const q of this.phones) if (contains(q.frame, m.x, m.y)) this.setFocus(q);
        return;
      }
      this.setFocus(p);
      p.touching = true;
      p.lastMove = performance.now();
      const [x, y] = p.point(m.x, m.y);
      this.report(p.session!.touch(x, y, true));
    } else if (m.motion && m.button === 0) {
      for (const p of this.phones) {
        if (p.touching && performance.now() - p.lastMove >= moveInterval) {
          p.lastMove = performance.now();
          const [x, y] = p.point(m.x, m.y);
          this.report(p.session!.touch(x, y, true));
        }
      }
    } else if (m.release) {
      for (const p of this.phones) {
        if (p.touching) {
          p.touching = false;
          const [x, y] = p.point(m.x, m.y);
          this.report(p.session!.touch(x, y, false));
        }
      }
    }
  }

  // flushWheel turns the wheel ticks of the last moment into one swipe
  // centred on the pointer. Sending a swipe per tick would queue up faster
  // than the phone plays them.
  private flushWheel(): void {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = undefined;
    const p = this.wheelPhone;
    const d = Math.min(Math.max(this.wheelDY * wheelStep, -400), 400);
    this.wheelDY = 0;
    if (!p || d === 0) return;
    const h = p.screen.heightPoints;
    const y0 = Math.min(Math.max(this.wheelY - d / 2, 1), h - 1);
    const y1 = Math.min(Math.max(this.wheelY + d / 2, 1), h - 1);
    this.report(p.session!.swipe(this.wheelX, y0, this.wheelX, y1, 0.08));
  }

  // usable reports whether a phone takes input yet, and says why not.
  private usable(p: Phone): boolean {
    if (p.connecting) this.flash(`${p.device.name} is still connecting`);
    else if (p.failed !== "") this.flash(`${p.device.name}: ${p.failed}`);
    else return true;
    return false;
  }

  // removePhone takes a phone out of the pane and shuts its device down.
  // The shutdown runs in the background, because it takes a second or two.
  removePhone(p: Phone): void {
    const i = this.phones.indexOf(p);
    this.phones.splice(i, 1);
    if (this.focus === p) this.focus = this.phones[Math.min(i, this.phones.length - 1)];
    if (this.phones.length < 2) this.solo = false;
    void p.close().then(() => shutdown(p.device));
    markShutDown(this, p.device.id);
    this.flash(`Shutting down ${p.device.name}`);
  }

  focusIndex(): number {
    return Math.max(0, this.phones.indexOf(this.focus!));
  }

  // toggleSolo switches between the grid and the focused phone filling the
  // pane.
  private async toggleSolo(): Promise<void> {
    if (this.phones.length < 2) return;
    await animate(this, () => {
      this.solo = !this.solo;
    });
  }

  // focusNext gives the keyboard to the next phone. While one phone fills the
  // pane, that phone takes its place.
  private focusNext(): void {
    const n = this.phones.length;
    if (n < 2) return;
    this.focus = this.phones[(this.focusIndex() + 1) % n];
    if (this.solo) this.relayout();
    else drawChrome(this);
  }

  private setFocus(p: Phone): void {
    if (this.focus !== p) {
      this.focus = p;
      drawChrome(this);
    }
  }

  // sendScreenshot saves a full-resolution screenshot of a phone and types
  // its path into the agent's pane, so the agent can look at the screen.
  // Without an agent, it copies the path.
  private async sendScreenshot(p: Phone): Promise<void> {
    let path: string;
    try {
      const png = await p.session!.screenshot();
      const dir = join(tmpdir(), "rexsim");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = p.device.name.replace(/[ /]/g, "-");
      const now = new Date();
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
      path = join(dir, `${name}-${time}-${randomBytes(4).toString("hex")}.png`);
      writeFileSync(path, png, { flag: "wx", mode: 0o600 });
    } catch (err) {
      this.flash((err as Error).message);
      return;
    }
    if (this.opts.agent && (await rexSend(this.opts.agent, path + " "))) {
      this.flash(`Sent a screenshot of ${p.device.name} to the agent's input`);
      return;
    }
    if (!(await spawnOK(["pbcopy"], new TextEncoder().encode(path)))) {
      this.flash(`Saved ${path}`);
      return;
    }
    this.flash(`Copied the screenshot's path: ${path}`);
  }
}

function rexSend(block: string, text: string): Promise<boolean> {
  return spawnOK(["rex", "send", "-s", process.env.REX_SESSION ?? "", "-b", block, text]);
}

// spawnOK reports whether a command ran and succeeded. Bun.spawn throws at
// once when the program isn't on PATH, where Go's Run returned an error.
async function spawnOK(cmd: string[], stdin?: Uint8Array): Promise<boolean> {
  try {
    return (await Bun.spawn(cmd, { stdin: stdin ?? "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
}
