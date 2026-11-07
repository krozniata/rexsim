// A client for the parts of idb_companion's gRPC service that rexsim uses:
// the raw framebuffer stream, HID input and screenshots.
import type * as grpcjs from "@grpc/grpc-js";
import idbProto from "../../proto/idb.proto" with { type: "text" };
import type { Button, Frame, Screen } from "../device";
import * as grpc from "../grpc";
import { KeyLeftShift, keysFor } from "../keys";

const CompanionService = grpc.loadService(idbProto, "idb.CompanionService");

type Hid = grpcjs.ClientWritableStream<grpc.Message>;

export class Client {
  private svc: grpc.Service;
  private hid: Hid | null = null;
  private sending = new grpc.Serial();

  constructor(socket: string) {
    this.svc = grpc.connect(CompanionService, `unix://${socket}`);
  }

  close(): void {
    this.hid?.end();
    this.hid = null;
    this.svc.close();
  }

  async describe(signal: AbortSignal): Promise<{ name: string; osVersion: string; screen: Screen }> {
    const res = await grpc.unary(this.svc, "describe", {}, undefined, signal);
    const d = res.target_description ?? {};
    const dim = d.screen_dimensions ?? {};
    const screen = { width: dim.width, height: dim.height, widthPoints: dim.width_points, heightPoints: dim.height_points };
    if (!screen.width || !screen.height || !screen.widthPoints || !screen.heightPoints) {
      throw new Error("the simulator reported no screen size");
    }
    return { name: d.name, osVersion: d.os_version, screen };
  }

  // stream sends raw frames to onFrame until signal aborts or the stream
  // fails, and resolves with the reason it stopped. The companion sends one
  // frame per message.
  stream(signal: AbortSignal, fps: number, scale: number, s: Screen, onFrame: (f: Frame) => void): Promise<Error> {
    const call: grpcjs.ClientDuplexStream<grpc.Message, any> = this.svc.video_stream();
    const stopped = grpc.readStream(call, signal, "the simulator stopped streaming", (res) => {
      const data: Uint8Array | undefined = res.payload?.data;
      if (!data?.length) return;
      const size = frameSize(data.length, s, scale);
      if (!size) return new Error(`unexpected frame of ${data.length} bytes at scale ${scale.toFixed(2)}`);
      onFrame({ ...size, channels: 4, bgra: true, pix: data });
    });
    call.write({ start: { fps, format: "RBGA", compression_quality: 1, scale_factor: scale } });
    return stopped;
  }

  // openHid marks the stream broken once its call ends. grpc-js never passes
  // an error to a write's callback, and a call that ended with an error
  // still looks writable, so without the mark a write would vanish into it.
  private openHid(): Hid {
    const hid: Hid = this.svc.hid(() => {
      broken.add(hid);
      if (this.hid === hid) this.hid = null;
    });
    hid.on("error", () => broken.add(hid));
    this.hid = hid;
    return hid;
  }

  // send writes events in order on one HID stream, reopening it once if it
  // broke. Calls queue behind each other, so a key's shift can't interleave
  // with another key.
  private send(...events: grpc.Message[]): Promise<void> {
    return this.sending.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const hid = this.hid ?? this.openHid();
        try {
          for (const ev of events) await write(hid, ev);
          return;
        } catch (err) {
          if (this.hid === hid) this.hid = null;
          if (attempt === 1) throw err;
        }
      }
    });
  }

  // touch puts the finger down at a point, moves it there while it is down,
  // or lifts it.
  touch(x: number, y: number, down: boolean): Promise<void> {
    return this.send(press({ touch: { point: { x, y } } }, down));
  }

  button(b: Button): Promise<void> {
    const action = { button: { button: b } };
    return this.send(press(action, true), press(action, false));
  }

  // key taps a key by its USB HID usage, holding shift if asked.
  key(code: number, shift: boolean): Promise<void> {
    return this.send(...keyEvents(code, shift));
  }

  // text types the characters that a US keyboard has, and skips the others.
  text(s: string): Promise<void> {
    const events = keysFor(s).flatMap((k) => keyEvents(k.code, k.shift));
    return events.length ? this.send(...events) : Promise.resolve();
  }

  swipe(x0: number, y0: number, x1: number, y1: number, seconds: number): Promise<void> {
    return this.send({ swipe: { start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, duration: seconds } });
  }

  async screenshot(): Promise<Uint8Array> {
    return (await grpc.unary(this.svc, "screenshot", { format: "PNG" })).image_data;
  }
}

const broken = new WeakSet<Hid>();

function write(hid: Hid, ev: grpc.Message): Promise<void> {
  return new Promise((resolve, reject) => {
    if (broken.has(hid) || hid.writableEnded || hid.destroyed) return reject(new Error("the HID stream closed"));
    hid.write(ev, (err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

function press(action: grpc.Message, down: boolean): grpc.Message {
  return { press: { action, direction: down ? "DOWN" : "UP" } };
}

function keyEvents(code: number, shift: boolean): grpc.Message[] {
  const key = (c: number, down: boolean) => press({ key: { keycode: c } }, down);
  const events = [key(code, true), key(code, false)];
  return shift ? [key(KeyLeftShift, true), ...events, key(KeyLeftShift, false)] : events;
}

// frameSize works out the frame's dimensions from its length. The companion
// doesn't report them and rounds the scaled size its own way. The buffer pads
// each row to an alignment, and can hold a few rows more than the image, as
// at full scale on a 2622-pixel-tall screen, which arrives as 2624 rows.
export function frameSize(n: number, s: Screen, scale: number): Omit<Frame, "pix" | "bgra" | "channels"> | null {
  for (const [dw, dh] of [
    [s.width, s.height],
    [s.height, s.width],
  ]) {
    for (const width of around(dw * scale)) {
      for (const align of [64, 16, 32, 128, 256, 4]) {
        const stride = Math.trunc((width * 4 + align - 1) / align) * align;
        if (width <= 0 || n % stride !== 0) continue;
        const rows = n / stride;
        for (const height of around(dh * scale)) {
          if (height > 0 && rows >= height && rows - height < 32) return { width, height, stride };
        }
      }
    }
  }
  return null;
}

function around(v: number): number[] {
  return [Math.round(v), Math.floor(v), Math.ceil(v)];
}
