import type { Device, Frame, Screen, Session } from "../device";
import { connect } from "../platforms";
import { Placer } from "../terminal/kitty";
import { emptyBox, type Box } from "./layout";
import { cornerMask, screenRadius, toRGBA } from "./shapes";

// ViewFrame is one screen, converted to RGBA with rounded corners.
export type ViewFrame = { width: number; height: number; rgba: Uint8Array };

// PhoneState is where a phone's connection stands. A phone whose stream
// failed keeps its session until it closes.
export type PhoneState =
  | { kind: "connecting"; cancel: AbortController }
  | { kind: "ready"; session: Session }
  | { kind: "failed"; reason: string; session?: Session };

const noScreen: Screen = { width: 0, height: 0, widthPoints: 0, heightPoints: 0 };

// Phone is one simulator or emulator in the pane, with its own session and
// stream.
export class Phone {
  state: PhoneState = { kind: "connecting", cancel: new AbortController() };

  private latest: Frame | null = null;
  private lastSum: number | bigint = 0;
  private corners: { r: number; mask: Uint8Array } = { r: -1, mask: new Uint8Array(0) };
  private stopStream: AbortController | null = null;
  scale = 0;

  placer = new Placer();
  current: ViewFrame | null = null;
  frameW = 0;
  frameH = 0;
  frame: Box = emptyBox;
  box: Box = emptyBox;
  border = new Placer();
  borderKey = "";

  touching = false;
  lastMove = 0;

  constructor(public device: Device) {}

  // session is the phone's session while it takes input.
  get session(): Session | null {
    return this.state.kind === "ready" ? this.state.session : null;
  }

  get screen(): Screen {
    return this.state.kind === "connecting" ? noScreen : (this.state.session?.screen ?? noScreen);
  }

  // connect boots the device if needed and connects to it in the
  // background. It leaves the result to the main loop, which owns the
  // phone's state.
  connect(signal: AbortSignal, progress: (text: string) => void): Promise<Connection> {
    const cancel = new AbortController();
    this.state = { kind: "connecting", cancel };
    return connect(AbortSignal.any([signal, cancel.signal]), this.device, progress).then(
      (session) => ({ p: this, session }),
      (err) => ({ p: this, err: err instanceof Error ? err : new Error(String(err)) }),
    );
  }

  // fail marks the phone failed, keeping its session to close later.
  fail(reason: string): void {
    this.state = { kind: "failed", reason, session: this.state.kind === "connecting" ? undefined : this.state.session };
  }

  async close(): Promise<void> {
    this.latest = null;
    this.stopStream?.abort();
    if (this.state.kind === "connecting") this.state.cancel.abort();
    else await this.state.session?.close();
    this.placer.close();
    this.border.close();
  }

  startStream(signal: AbortSignal, fps: number, ready: () => void, failed: (err: Error) => void): void {
    const session = this.session;
    if (!session) return;
    this.stopStream?.abort();
    const stop = new AbortController();
    this.stopStream = stop;
    this.lastSum = 0;
    const streamSignal = AbortSignal.any([signal, stop.signal]);
    session.stream(streamSignal, fps, this.scale, (f) => this.onFrame(f, ready)).then((err) => {
      if (!streamSignal.aborted) failed(err);
    });
  }

  // pauseStream stops the stream of a phone that is hidden. Clearing the
  // scale makes relayout start it again once the phone shows.
  pauseStream(): void {
    this.stopStream?.abort();
    this.stopStream = null;
    this.scale = 0;
  }

  // onFrame only keeps the newest raw frame. Everything runs on one thread,
  // unlike Go's goroutine per stream, so the conversion waits for takeLatest
  // and is skipped for frames that a newer one replaces before they're drawn.
  // A companion sends frames at a steady rate even when nothing changes,
  // so identical ones are dropped.
  private onFrame(f: Frame, ready: () => void): void {
    const sum = Bun.hash(f.pix);
    const same = sum === this.lastSum;
    this.lastSum = sum;
    if (same) return;
    this.latest = f;
    ready();
  }

  takeLatest(): ViewFrame | null {
    const f = this.latest;
    if (!f) return null;
    this.latest = null;
    const r = Math.trunc(screenRadius(f.width / f.height, this.device.platform) * f.width);
    if (r !== this.corners.r) this.corners = { r, mask: cornerMask(r) };
    return { width: f.width, height: f.height, rgba: toRGBA(f.pix, f.width, f.height, f.stride, this.corners.mask, r, f.bgra) };
  }

  // aspect is the phone's width over its height: the frame's once one
  // arrives, since it turns with the phone, and the screen's before that.
  // Layout uses only the ratio, because a frame's pixel size depends on the
  // stream's scale, which in turn follows the drawn size.
  aspect(): number {
    if (this.frameW > 0 && this.frameH > 0) return this.frameW / this.frameH;
    if (this.screen.width > 0 && this.screen.height > 0) return this.screen.width / this.screen.height;
    return this.device.name.includes("iPad") ? 0.72 : 0.46;
  }

  // wantScale streams at the size the phone is drawn, in steps of 5% so small
  // resizes keep the stream running.
  wantScale(): number {
    if (this.box.h === 0) return 0.5;
    const s = Math.ceil((this.box.h / this.screen.height) * 20) / 20;
    return Math.min(this.maxScale(), Math.max(0.1, s));
  }

  // maxScale keeps frames within what the stream can send at full rate. A
  // phone drawn larger is scaled up by the terminal, slightly softer but
  // smooth.
  private maxScale(): number {
    const max = this.session?.maxPixels;
    if (!max) return 1;
    const s = Math.sqrt(max / (this.screen.width * this.screen.height));
    return Math.min(1, Math.floor(s * 20) / 20);
  }

  // point maps a pixel in the pane to a point on the phone's screen.
  point(px: number, py: number): [number, number] {
    const b = this.box;
    if (b.w === 0) return [0, 0];
    const fx = Math.min(Math.max((px - b.x) / b.w, 0), 0.999);
    const fy = Math.min(Math.max((py - b.y) / b.h, 0), 0.999);
    return [fx * this.screen.widthPoints, fy * this.screen.heightPoints];
  }
}

// Connection is the result of connect, handed to the main loop.
export type Connection = { p: Phone; session: Session } | { p: Phone; err: Error };

export async function closeConnection(c: Connection): Promise<void> {
  if ("session" in c) await c.session.close();
}
