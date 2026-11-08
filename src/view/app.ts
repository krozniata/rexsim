// Shows simulators and emulators in the terminal and sends the mouse and
// keyboard to them.
import * as control from "../control";
import { type Device, label, resolve, type Session } from "../device";
import * as keys from "../keys";
import { devices as listDevices, shutdown } from "../platforms";
import { type InputEvent, type Key, readEvents } from "../terminal/input";
import * as kitty from "../terminal/kitty";
import { cellWidth, type Size, Terminal } from "../terminal/term";
import { animate } from "./animate";
import { drawChrome } from "./chrome";
import { computeLayout, computeSoloLayout, emptyBox } from "./layout";
import { closeConnection, type Connection, Phone, type ViewFrame } from "./phone";
import { chooseDevices } from "./picker";
import { Pointer } from "./pointer";
import { Queue } from "./queue";
import { sendScreenshot } from "./screenshot";
import { markShutDown, panelCol, type Sidebar, sidebarKey, toggleSidebar } from "./sidebar";
import { colorOf, dark, light, luminance, type Palette, type RGB, sgr } from "./theme";

export type Options = { ids: string[]; agent: string };

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
  | { kind: "show"; keys: string[]; reply: (r: control.Reply) => void }
  | { kind: "quit" };

const statusTime = 4000;
const streamFps = 60;
const thumbFps = 10;
const fetchTimeout = 200;
const themeTimeout = 300;

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
  kitty.removeTemps();
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
  // background is the pane's colour, which fills a frame's corners so it
  // can be sent without an alpha channel: black until the terminal says.
  background: RGB = [0, 0, 0];
  phones: Phone[] = [];
  focus: Phone | null = null;
  solo = false;
  private added = 0;
  private syncs = 0;
  sidebar: Sidebar | null = null;
  private readyQueued = false;
  private tick: ReturnType<typeof setInterval> | undefined;
  private stopServing = () => {};
  private pointer = new Pointer(this);

  status = "";
  statusUntil = 0;

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
    this.message("Looking for devices…");
    const devices = await chooseDevices(this);
    this.focus = this.add(devices)[0];
    this.updateSize();
    this.relayout();
    this.serve();

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
            const f = p.takeLatest(this.background);
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
          if (this.sizeChanged()) this.relayout();
          else drawChrome(this);
          break;
        case "wheel":
          this.pointer.flushWheel();
          break;
        case "dialed":
          await this.dialDone(ev.c);
          break;
        case "error":
          this.flash(ev.text);
          break;
        case "show":
          ev.reply(await this.show(ev.keys));
          break;
      }
    }
  }

  stopTimers(): void {
    clearInterval(this.tick);
    this.pointer.stop();
    this.stopServing();
  }

  // serve takes "rexsim show" requests for this Rex session. Outside Rex
  // there is no session to be found by.
  private serve(): void {
    const session = process.env.REX_SESSION;
    if (!session) return;
    try {
      this.stopServing = control.serve(control.controlPath(session), (req) => {
        return new Promise((reply) => this.events.push({ kind: "show", keys: req.show, reply }));
      });
    } catch (err) {
      this.flash(`rexsim show can't reach this pane: ${(err as Error).message}`);
    }
  }

  // show adds the named devices, or every booted one, and focuses the first.
  // A phone whose device stopped is replaced, since a test run may have
  // restarted it.
  private async show(keys: string[]): Promise<control.Reply> {
    let wanted: Device[];
    try {
      wanted = resolve(await listDevices(this.signal), keys);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    for (const p of this.phones.filter((p) => p.state.kind === "failed" && wanted.some((d) => d.id === p.device.id))) {
      this.phones.splice(this.phones.indexOf(p), 1);
      p.border.delete(this.t);
      void p.close();
    }
    const fresh = wanted.filter((d) => !this.phones.some((p) => p.device.id === d.id));
    const added = this.add(fresh);
    this.focus = this.phones.find((p) => p.device.id === wanted[0].id) ?? this.focus;
    if (this.phones.length < 2) this.solo = false;
    this.relayout();
    const names = wanted.map(label).join(", ");
    return { ok: true, message: added.length > 0 ? `showing ${names}` : `already showing ${names}` };
  }

  // add shows a placeholder for each device at once and connects them in the
  // background, so the other phones stay usable while a device boots. Each
  // phone gets image ids no other phone has used, so a closed phone's images
  // can't be mistaken for a new one's.
  add(devices: Device[]): Phone[] {
    const phones = devices.map((d) => {
      const p = new Phone(d);
      p.placer.base = this.added * 2;
      p.border.base = 1_000_000 + this.added * 2;
      this.added++;
      p.connect(this.signal, (text) => this.flash(text)).then((c) => this.events.push({ kind: "dialed", c }));
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
    p.state = "session" in c ? { kind: "ready", session: c.session } : { kind: "failed", reason: c.err.message };
    this.relayout();
    if ("session" in c && c.session.warning) this.flash(`${p.device.name} ${c.session.warning}`);
  }

  // streamFailed keeps the other phones running when one stops, for example
  // because its device shut down.
  private streamFailed(failed: Phone, err: Error): void {
    failed.fail(err.message);
    if (this.phones.some((p) => p.state.kind !== "failed")) {
      this.flash(`${failed.device.name}: ${err.message}`);
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
        const c = colorOf(ev.text.slice(3));
        if (!c) return;
        this.background = c;
        if (luminance(c) > 0.5) this.pal = light;
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
    const resized = p.current?.width !== f.width || p.current?.height !== f.height;
    p.current = f;
    if (resized) {
      this.relayout();
      return;
    }
    if (p.box.cols === 0) return;
    let path: string;
    try {
      path = kitty.writeTemp(f.pix);
    } catch (err) {
      this.flash((err as Error).message);
      return;
    }
    this.beginSync();
    p.placer.place(this.t, path, 24, f.width, f.height, p.box.col, p.box.row, p.box.cols, p.box.rows, 0);
    this.endSync();
  }

  // visible lists the phones on screen. While one fills the pane it comes
  // first, then the others in the order ⌃N reaches them, top to bottom in
  // their column.
  visible(): Phone[] {
    if (!this.solo) return this.phones;
    const i = this.focusIndex();
    return [...this.phones.slice(i), ...this.phones.slice(0, i)];
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
    const aspects = shown.map((p) => p.aspect());
    const placements = this.solo ? computeSoloLayout(this.phoneArea(), aspects[0], aspects.slice(1)) : computeLayout(this.phoneArea(), aspects);
    placements?.forEach((pl, i) => {
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
        const fps = this.solo && p !== this.focus ? thumbFps : streamFps;
        if ((s !== p.scale || fps !== p.fps) && p.session) {
          p.scale = s;
          this.stream(p, fps);
        }
        if (p.current) this.paint(p, p.current);
      }
    } finally {
      this.endSync();
    }
  }

  private stream(p: Phone, fps: number): void {
    p.startStream(this.signal, fps, () => this.queueReady(), (err) => this.events.push({ kind: "failure", p, err }));
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
      case "paste": {
        const s = this.sidebar ? null : this.usable(this.focus!);
        if (s) this.report(s.text(ev.text));
        return;
      }
      case "mouse":
        return this.pointer.mouse(ev);
    }
  }

  // key sends typing to the phone clicked last.
  private async key(k: Key): Promise<void> {
    if (this.sidebar && (await sidebarKey(this, k))) return;
    switch (k.name) {
      case "ctrl+c":
        throw new Quit();
      case "ctrl+f":
        await this.toggleSolo();
        break;
      case "ctrl+n":
        await this.focusNext();
        break;
      case "ctrl+o":
        await toggleSidebar(this);
        break;
    }
    const p = this.focus!;
    const c = this.usable(p);
    if (!c) return;
    switch (k.name) {
      case "ctrl+b":
        this.report(c.home());
        break;
      case "ctrl+s":
        await sendScreenshot(this, p, c);
        break;
      case "ctrl+r":
        this.report(c.rotate());
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

  // usable returns a phone's session if it takes input yet, and says why
  // not otherwise.
  private usable(p: Phone): Session | null {
    if (p.state.kind === "connecting") this.flash(`${p.device.name} is still connecting`);
    else if (p.state.kind === "failed") this.flash(`${p.device.name}: ${p.state.reason}`);
    return p.session;
  }

  // removePhone takes a phone out of the pane and shuts its device down.
  // The shutdown runs in the background, because it takes a second or two.
  removePhone(p: Phone): void {
    const i = this.phones.indexOf(p);
    this.phones.splice(i, 1);
    p.border.delete(this.t);
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
  // pane, that phone glides into its place.
  private async focusNext(): Promise<void> {
    const n = this.phones.length;
    if (n < 2) return;
    await this.select(this.phones[(this.focusIndex() + 1) % n]);
  }

  // select gives the keyboard to p. While one phone fills the pane, p takes
  // its place and the one before joins the column. A thumbnail only has the
  // small frames it streams, which would blur as it grows, so p first
  // streams at its new size, and glides once that frame is in or after
  // fetchTimeout.
  async select(p: Phone): Promise<void> {
    if (this.focus === p) return;
    if (!this.solo) {
      this.setFocus(p);
      return;
    }
    const big = this.focus!.box.h;
    if (p.session && big > 0) {
      p.scale = p.wantScale(big);
      this.stream(p, streamFps);
      await p.frameDue(fetchTimeout);
      const f = p.takeLatest(this.background);
      if (f) p.current = f;
    }
    await animate(this, () => (this.focus = p));
  }

  setFocus(p: Phone): void {
    if (this.focus !== p) {
      this.focus = p;
      drawChrome(this);
    }
  }
}
