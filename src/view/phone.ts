import { connect, type Device, type Frame, type Screen, type Session } from "../device";
import { Placer } from "../kitty";
import { emptyBox, type Box } from "./layout";
import { cornerMask, screenRadius, toRGBA } from "./shapes";

// ViewFrame is one screen, converted to RGBA with rounded corners.
export type ViewFrame = { width: number; height: number; rgba: Uint8Array };

// Phone is one simulator or emulator in the pane, with its own session and
// stream.
export class Phone {
  session: Session | null = null;
  screen: Screen = { width: 0, height: 0, widthPoints: 0, heightPoints: 0 };

  private latest: Frame | null = null;
  private lastSum: number | bigint = 0;
  private corners: { r: number; mask: Uint8Array } = { r: -1, mask: new Uint8Array(0) };
  private stopStream: AbortController | null = null;
  scale = 0;
  failed = "";

  connecting = true;
  cancelConnect: AbortController | null = null;

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

  async close(): Promise<void> {
    this.latest = null;
    this.cancelConnect?.abort();
    this.stopStream?.abort();
    await this.session?.close();
    this.placer.close();
    this.border.close();
  }

  startStream(signal: AbortSignal, fps: number, ready: () => void, failed: (err: Error) => void): void {
    this.stopStream?.abort();
    const stop = new AbortController();
    this.stopStream = stop;
    this.lastSum = 0;
    const streamSignal = AbortSignal.any([signal, stop.signal]);
    this.session!.stream(streamSignal, fps, this.scale, (f) => this.onFrame(f, ready)).then((err) => {
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
    return Math.min(1, Math.max(0.1, s));
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

// Connection is the result of dial, handed to the main loop, which owns the
// phone's fields.
export type Connection = { p: Phone; session?: Session; err?: Error };

export async function closeConnection(c: Connection): Promise<void> {
  await c.session?.close();
}

// dial boots a device if needed and connects to it. It doesn't touch the
// phone.
export async function dial(signal: AbortSignal, companionBin: () => Promise<string>, p: Phone, d: Device): Promise<Connection> {
  try {
    return { p, session: await connect(signal, d, companionBin) };
  } catch (err) {
    return { p, err: err instanceof Error ? err : new Error(String(err)) };
  }
}
