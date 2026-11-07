// Android emulators, which their own gRPC service streams and drives.
import type { Device, Frame, Provider, Screen, Session } from "../device";
import type { Message } from "../grpc";
import { KeyLeftShift, keysFor } from "../keys";
import * as avd from "./avd";
import { Client } from "./emulator";

export const android: Provider = {
  devices: () => avd.devices(),
  connect,
  shutdown: (d) => void avd.shutdown(d.id).catch(() => {}),
};

async function connect(signal: AbortSignal, d: Device): Promise<Session> {
  const e = avd.running(d.id) ?? (await avd.boot(signal, d.id));
  const client = new Client(e.port, e.token);
  try {
    const hw = await client.waitBooted(signal);
    const warning = avd.rendersOnCPU(hw) ? "renders on the CPU and may stutter; restart it by hiding and showing it with ⌃O" : undefined;
    return new Emulator(client, d.runtime, avd.screenOf(hw), warning);
  } catch (err) {
    client.close();
    throw err;
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
    readonly warning?: string,
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

  home(): Promise<void> {
    return this.client.send("sendKey", [{ eventType: "keypress", key: "GoHome" }]);
  }

  key(code: number, shift: boolean): Promise<void> {
    return this.client.send("sendKey", keyEvents(code, shift));
  }

  // text types the characters that a US keyboard has, and skips the others,
  // as on a simulator. The emulator's own text field drops most others too.
  text(s: string): Promise<void> {
    const events = keysFor(s).flatMap((k) => keyEvents(k.code, k.shift));
    return events.length ? this.client.send("sendKey", events) : Promise.resolve();
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
