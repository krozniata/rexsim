// iOS simulators, which idb_companion streams and drives.
import { clockwise, type Device, type Orientation, type Provider, type Screen, type Session, unturn } from "../device";
import * as companion from "./companion";
import { Client } from "./idb";
import * as simctl from "./simctl";

// maxPixels is about what idb_companion can send at 60 fps, some 320 MB/s of
// raw pixels.
export const maxPixels = 1_300_000;

const holdInterval = 1000;

export const ios: Provider = {
  devices: simctl.devices,
  connect,
  shutdown: (d) => simctl.shutdown(d.id),
};

async function connect(signal: AbortSignal, d: Device, progress: (text: string) => void): Promise<Session> {
  const bin = await companion.binary(progress);
  if (!d.booted) await simctl.boot(signal, d.id);
  const comp = await companion.start(signal, bin, d.id);
  const client = new Client(comp.socket);
  const watching = new AbortController();
  const close = async () => {
    watching.abort();
    client.close();
    await comp.close();
  };
  try {
    const desc = await client.describe(signal);
    const screen = desc.screen;
    const hold = new Hold(screen, d.name.includes("iPad"));
    // idb_companion keeps the stream open, sending nothing, once the
    // simulator shuts down, so the watch ends it instead.
    const gone = new AbortController();
    void hold.watch(client, watching.signal, async () => {
      const booted = (await simctl.devices(watching.signal)).some((x) => x.id === d.id && x.booted);
      if (!booted) gone.abort();
      return !booted;
    });
    return {
      os: "iOS " + desc.osVersion.replace(/^iOS/, "").trim(),
      screen,
      maxPixels,
      get top() {
        return hold.top;
      },
      stream: async (signal, _fps, scale, onFrame) => {
        const err = await client.stream(AbortSignal.any([signal, gone.signal]), scale, screen, (f) => {
          hold.sideways = f.width > f.height !== screen.width > screen.height;
          onFrame({ ...f, turn: hold.turn });
        });
        return gone.signal.aborted ? new Error("shut down") : err;
      },
      touch: (x, y, down) => client.touch(...hold.unturn(x, y), down),
      rotate: async () => {
        const held = (await client.orientation()) ?? "portrait";
        const next = clockwise[(clockwise.indexOf(held) + 1) % 4];
        await client.setOrientation(next);
        hold.set(next);
      },
      home: () => client.home(),
      key: (code, shift) => client.key(code, shift),
      text: (s) => client.text(s),
      screenshot: () => client.screenshot(),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

// Hold works out how to show a simulator the way its device is held.
// Frames and touches follow the app rather than the device, so a frame
// turns by however far the device is turned past the app, and a touch
// turns back. A frame's shape says whether the app is sideways, and the
// device which way. A sideways app on an upright device keeps the way it
// last turned, at first with the device's top on the right, where an app
// that lists UIInterfaceOrientationLandscapeLeft first starts. Few iPhones
// draw upside down, so only an iPad's app is taken to turn over with it.
export class Hold {
  sideways = false;
  private held: Orientation = "portrait";
  private landscape: Orientation = "landscapeRight";

  constructor(
    private screen: Screen,
    private ipad: boolean,
  ) {}

  set(o: Orientation): void {
    this.held = o;
    if (o === "landscapeLeft" || o === "landscapeRight") this.landscape = o;
  }

  // top is how many quarter turns clockwise the device is held from
  // portrait, which is the side of the screen its top is on.
  get top(): number {
    return clockwise.indexOf(this.held);
  }

  get turn(): number {
    return (this.top - this.app + 4) % 4;
  }

  // unturn maps a point on the screen as it shows to the point the app
  // takes.
  unturn(x: number, y: number): [number, number] {
    const s = this.screen;
    const [w, h] = this.app % 2 === 1 ? [s.heightPoints, s.widthPoints] : [s.widthPoints, s.heightPoints];
    return unturn(x, y, this.turn, w, h);
  }

  private get app(): number {
    if (this.sideways) return clockwise.indexOf(this.landscape);
    return this.held === "portraitUpsideDown" && this.ipad ? 2 : 0;
  }

  // watch follows the device as something else turns it, such as a test.
  // When the device doesn't answer, it stops once stopped reports that the
  // device shut down.
  async watch(client: Client, signal: AbortSignal, stopped: () => Promise<boolean>): Promise<void> {
    while (!signal.aborted) {
      try {
        const o = await client.orientation(signal);
        if (o) this.set(o);
      } catch {
        if (!signal.aborted && (await stopped().catch(() => false))) return;
      }
      await Bun.sleep(holdInterval);
    }
  }
}
