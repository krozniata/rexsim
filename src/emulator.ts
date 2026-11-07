// A client for the parts of the Android emulator's gRPC service that rexsim
// uses: the screen stream, touches and keys, screenshots and shutting down.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import emulatorProto from "../proto/emulator.proto" with { type: "text" };
import type { Button, Frame, Screen, Session } from "./device";
import { KeyLeftShift, keyFor } from "./keys";

const definition = protoLoader.fromJSON(protobuf.parse(emulatorProto, { keepCase: true }).root.toJSON(), {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});
const control = (((grpc.loadPackageDefinition(definition).android as grpc.GrpcObject).emulation as grpc.GrpcObject)
  .control as grpc.GrpcObject);
const EmulatorController = control.EmulatorController as grpc.ServiceClientConstructor;

type Message = Record<string, unknown>;

const bootTimeout = 180_000;

export class Client {
  private svc: grpc.Client & Record<string, any>;
  private meta = new grpc.Metadata();
  private sending: Promise<unknown> = Promise.resolve();

  // The emulator listens on 127.0.0.1 only, and refuses calls without the
  // token from its discovery file. The window is widened as for a simulator,
  // so large frames don't wait on window updates.
  constructor(port: number, token: string) {
    this.svc = new EmulatorController(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
      "grpc.max_receive_message_length": 256 << 20,
      "grpc-node.flow_control_window": 16 << 20,
    });
    if (token) this.meta.set("authorization", `Bearer ${token}`);
  }

  close(): void {
    this.svc.close();
  }

  private call(method: string, req: Message, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      const call = this.svc[method](req, this.meta, (err: grpc.ServiceError | null, res: any) => {
        signal?.removeEventListener("abort", cancel);
        err ? reject(err) : resolve(res);
      });
      const cancel = () => call.cancel();
      signal?.addEventListener("abort", cancel);
    });
  }

  // send makes input calls one at a time, gap milliseconds apart. Unary
  // calls share one connection and can overtake each other, which would
  // reorder a finger's moves.
  send(method: string, reqs: Message[], gap = 0): Promise<void> {
    const next = this.sending.then(async () => {
      for (const [i, req] of reqs.entries()) {
        if (i > 0 && gap > 0) await Bun.sleep(gap);
        await this.call(method, req);
      }
    });
    this.sending = next.catch(() => {});
    return next;
  }

  // waitBooted waits for Android to finish booting and returns the
  // emulator's hardware config. The service refuses calls for a moment after
  // its discovery file appears, so failures are retried until the deadline,
  // except for refusals, which won't change.
  async waitBooted(signal: AbortSignal): Promise<Record<string, string>> {
    const deadline = Date.now() + bootTimeout;
    for (;;) {
      try {
        const s = await this.call("getStatus", {}, signal);
        if (s.booted) return Object.fromEntries((s.hardwareConfig?.entry ?? []).map((e: any) => [e.key, e.value]));
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        const code = (err as grpc.ServiceError).code;
        if (code === grpc.status.UNAUTHENTICATED || code === grpc.status.PERMISSION_DENIED || code === grpc.status.UNIMPLEMENTED) {
          throw err;
        }
        if (Date.now() > deadline) throw err;
      }
      if (Date.now() > deadline) throw new Error("the emulator did not finish booting");
      if (signal.aborted) throw signal.reason;
      await Bun.sleep(500);
    }
  }

  // stream sends frames that fit in a side by side square to onFrame until
  // signal aborts or the stream fails, and resolves with the reason it
  // stopped. A square keeps a rotated screen as large as an upright one. The
  // emulator sends a frame only when the screen changes, and an empty one
  // while the display is off.
  stream(signal: AbortSignal, side: number, onFrame: (f: Frame) => void): Promise<Error> {
    return new Promise((resolve) => {
      const call: grpc.ClientReadableStream<any> = this.svc.streamScreenshot(
        { format: "RGBA8888", width: side, height: side },
        this.meta,
      );
      let done = false;
      const finish = (err: Error) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", cancel);
        call.cancel();
        resolve(err);
      };
      const cancel = () => finish(new Error("stream stopped"));
      signal.addEventListener("abort", cancel);
      call.on("data", (img: any) => {
        const width: number = img.format?.width ?? 0;
        const height: number = img.format?.height ?? 0;
        const pix: Uint8Array | undefined = img.image;
        if (done || !width || !height || !pix || pix.length < width * height * 4) return;
        onFrame({ width, height, stride: width * 4, bgra: false, pix });
      });
      call.on("end", () => finish(new Error("the emulator stopped streaming")));
      call.on("error", (err: Error) => finish(err));
    });
  }

  async screenshot(): Promise<Uint8Array> {
    return (await this.call("getScreenshot", { format: "PNG" })).image;
  }

  async setVmState(state: string): Promise<void> {
    await this.call("setVmState", { state });
  }
}

// Emulator is a booted emulator as a Session. It converts points to the
// pixels that the emulator's touches take.
export class Emulator implements Session {
  private scale: number;

  constructor(
    private client: Client,
    readonly os: string,
    readonly screen: Screen,
  ) {
    this.scale = screen.width / screen.widthPoints;
  }

  stream(signal: AbortSignal, _fps: number, scale: number, onFrame: (f: Frame) => void): Promise<Error> {
    const side = Math.max(1, Math.round(Math.max(this.screen.width, this.screen.height) * scale));
    return this.client.stream(signal, side, onFrame);
  }

  touch(x: number, y: number, down: boolean): Promise<void> {
    return this.client.send("sendTouch", [this.touchEvent(x, y, down)]);
  }

  private touchEvent(x: number, y: number, down: boolean): Message {
    return { touches: [{ x: Math.round(x * this.scale), y: Math.round(y * this.scale), identifier: 0, pressure: down ? 1 : 0 }] };
  }

  button(b: Button): Promise<void> {
    return this.client.send("sendKey", [{ eventType: "keypress", key: b === "HOME" ? "GoHome" : "Power" }]);
  }

  key(code: number, shift: boolean): Promise<void> {
    return this.client.send("sendKey", keyEvents(code, shift));
  }

  // text types the characters that a US keyboard has, and skips the others,
  // as on a simulator. The emulator's own text field drops most others too.
  text(s: string): Promise<void> {
    const events: Message[] = [];
    for (const ch of s) {
      const k = keyFor(ch);
      if (k) events.push(...keyEvents(k.code, k.shift));
    }
    return events.length ? this.client.send("sendKey", events) : Promise.resolve();
  }

  // swipe drags a finger in steps over the given time, because the emulator
  // has no swipe of its own and Android reads a fling's speed from the
  // steps. They queue as one batch so a click can't land in the middle.
  swipe(x0: number, y0: number, x1: number, y1: number, seconds: number): Promise<void> {
    const gap = 10;
    const steps = Math.max(2, Math.round((seconds * 1000) / gap));
    const events: Message[] = [];
    for (let i = 0; i <= steps; i++) {
      events.push(this.touchEvent(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, i < steps));
    }
    return this.client.send("sendTouch", events, gap);
  }

  screenshot(): Promise<Uint8Array> {
    return this.client.screenshot();
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

// keyEvents names keys by their full USB HID code, page 7 included, which is
// what the emulator's Chromium table is keyed on; a bare usage is dropped.
function keyEvents(code: number, shift: boolean): Message[] {
  const usb = (c: number, eventType: string) => ({ codeType: "Usb", eventType, keyCode: 0x070000 | c });
  const tap = usb(code, "keypress");
  return shift ? [usb(KeyLeftShift, "keydown"), tap, usb(KeyLeftShift, "keyup")] : [tap];
}
