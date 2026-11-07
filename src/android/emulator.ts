// A client for the parts of the Android emulator's gRPC service that rexsim
// uses: the screen stream, touches and keys, screenshots and shutting down.
import * as grpcjs from "@grpc/grpc-js";
import emulatorProto from "../../proto/emulator.proto" with { type: "text" };
import type { Frame } from "../device";
import { poll } from "../exec";
import * as grpc from "../grpc";

const EmulatorController = grpc.loadService(emulatorProto, "android.emulation.control.EmulatorController");

type Message = grpc.Message;

const bootTimeout = 180_000;

export class Client {
  private svc: grpc.Service;
  private meta = new grpcjs.Metadata();
  private sending = new grpc.Serial();

  // The emulator listens on 127.0.0.1 only, and refuses calls without the
  // token from its discovery file.
  constructor(port: number, token: string) {
    this.svc = grpc.connect(EmulatorController, `127.0.0.1:${port}`);
    if (token) this.meta.set("authorization", `Bearer ${token}`);
  }

  close(): void {
    this.svc.close();
  }

  private call(method: string, req: Message, signal?: AbortSignal): Promise<any> {
    return grpc.unary(this.svc, method, req, this.meta, signal);
  }

  // send makes input calls one at a time, gap milliseconds apart. Unary
  // calls share one connection and can overtake each other, which would
  // reorder a finger's moves.
  send(method: string, reqs: Message[], gap = 0): Promise<void> {
    return this.sending.run(async () => {
      for (const [i, req] of reqs.entries()) {
        if (i > 0 && gap > 0) await Bun.sleep(gap);
        await this.call(method, req);
      }
    });
  }

  // waitBooted waits for Android to finish booting and returns the
  // emulator's hardware config. The service refuses calls for a moment after
  // its discovery file appears, so failures are retried until the deadline,
  // except for refusals, which won't change.
  waitBooted(signal: AbortSignal): Promise<Record<string, string>> {
    let last: Error | undefined;
    return poll(signal, bootTimeout, 500, () => last ?? new Error("the emulator did not finish booting"), async () => {
      try {
        const s = await this.call("getStatus", {}, signal);
        last = undefined;
        if (s.booted) return Object.fromEntries((s.hardwareConfig?.entry ?? []).map((e: any) => [e.key, e.value]));
      } catch (err) {
        const code = (err as grpcjs.ServiceError).code;
        if (code === grpcjs.status.UNAUTHENTICATED || code === grpcjs.status.PERMISSION_DENIED || code === grpcjs.status.UNIMPLEMENTED) {
          throw err;
        }
        last = err as Error;
      }
    });
  }

  // stream sends frames that fit in a side by side square to onFrame until
  // signal aborts or the stream fails, and resolves with the reason it
  // stopped. A square keeps a rotated screen as large as an upright one. The
  // emulator sends a frame only when the screen changes, and an empty one
  // while the display is off. Frames come as RGB, a quarter smaller than
  // RGBA, which rexsim would only have to strip of its alpha.
  stream(signal: AbortSignal, side: number, onFrame: (f: Frame) => void): Promise<Error> {
    const call: grpcjs.ClientReadableStream<any> = this.svc.streamScreenshot({ format: "RGB888", width: side, height: side }, this.meta);
    return grpc.readStream(call, signal, "the emulator stopped streaming", (img) => {
      const width: number = img.format?.width ?? 0;
      const height: number = img.format?.height ?? 0;
      const pix: Uint8Array | undefined = img.image;
      if (!width || !height || !pix || pix.length < width * height * 3) return;
      onFrame({ width, height, stride: width * 3, channels: 3, bgra: false, pix });
    });
  }

  async screenshot(): Promise<Uint8Array> {
    return (await this.call("getScreenshot", { format: "PNG" })).image;
  }

  async setVmState(state: string): Promise<void> {
    await this.call("setVmState", { state });
  }
}
