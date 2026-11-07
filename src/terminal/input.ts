// Key is a typed character in rune, or a named key such as "enter", "up" or
// "ctrl+b" in name.
export type Key = { kind: "key"; rune: string; name: string };

// Mouse is an SGR mouse report. x and y are zero-based pixels while mode 1016
// is on. button is 0 to 2 for the left, middle and right buttons, 3 for none,
// and 64 to 67 for the wheel.
export type Mouse = { kind: "mouse"; button: number; x: number; y: number; release: boolean; motion: boolean };

export type Paste = { kind: "paste"; text: string };

// OSC is a reply to an operating system command query, such as "11;rgb:…"
// for the background colour.
export type OSC = { kind: "osc"; text: string };

export type InputEvent = Key | Mouse | Paste | OSC;

const named = (name: string): Key => ({ kind: "key", rune: "", name });

const escTimeout = 30;
const partialTimeout = 1000;

const decoder = new TextDecoder("utf-8", { fatal: true });

// readEvents parses stdin and passes each Key, Mouse and Paste to out. A lone
// escape becomes the "esc" key once no more input follows it. Any other
// unfinished sequence, such as a mouse report split across reads, waits
// longer for its rest, and is dropped rather than typed if that never comes.
export function readEvents(input: NodeJS.ReadStream, out: (ev: InputEvent) => void): void {
  let pending = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    if (pending.length === 1 && pending[0] === 0x1b) out(named("esc"));
    pending = Buffer.alloc(0);
  };
  input.on("data", (chunk: Buffer) => {
    clearTimeout(timer);
    pending = Buffer.concat([pending, chunk]);
    while (pending.length > 0) {
      const [ev, n] = parse(pending);
      if (n === 0) {
        timer = setTimeout(expire, pending.length === 1 ? escTimeout : partialTimeout);
        break;
      }
      pending = pending.subarray(n);
      if (ev) out(ev);
    }
  });
}

// parse reads one event from the front of b. It returns n === 0 when b
// holds only the start of an event.
export function parse(b: Buffer): [InputEvent | null, number] {
  const c = b[0];
  if (c === 0x1b) return parseEscape(b);
  if (c === 0x0d || c === 0x0a) return [named("enter"), 1];
  if (c === 0x09) return [named("tab"), 1];
  if (c === 0x7f || c === 0x08) return [named("backspace"), 1];
  if (c === 0x1d) return [named("ctrl+]"), 1];
  if (c >= 1 && c <= 26) return [named("ctrl+" + String.fromCharCode(97 + c - 1)), 1];
  if (c < 0x20) return [null, 1];
  const size = c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
  if (b.length < size) return [null, 0];
  try {
    return [{ kind: "key", rune: decoder.decode(b.subarray(0, size)), name: "" }, size];
  } catch {
    return [null, 1];
  }
}

// parseOSC reads an OSC reply, which ends with BEL or ST.
function parseOSC(b: Buffer): [InputEvent | null, number] {
  for (let i = 2; i < b.length; i++) {
    if (b[i] === 0x07) return [{ kind: "osc", text: b.toString("utf8", 2, i) }, i + 1];
    if (b[i] === 0x1b && i + 1 < b.length && b[i + 1] === 0x5c) return [{ kind: "osc", text: b.toString("utf8", 2, i) }, i + 2];
  }
  return [null, b.length > 512 ? 1 : 0];
}

function parseEscape(b: Buffer): [InputEvent | null, number] {
  if (b.length < 2) return [null, 0];
  switch (b[1]) {
    case 0x4f: // O
      if (b.length < 3) return [null, 0];
      return [arrow(b[2]), 3];
    case 0x5d: // ]
      return parseOSC(b);
    case 0x5b: // [
      break;
    default:
      return [named("esc"), 1];
  }
  let end = -1;
  for (let i = 2; i < b.length; i++) {
    if (b[i] >= 0x40 && b[i] <= 0x7e) {
      end = i;
      break;
    }
  }
  if (end < 0) return [null, b.length > 64 ? 1 : 0];
  const params = b.toString("latin1", 2, end);
  const final = String.fromCharCode(b[end]);
  if (params.startsWith("<") && (final === "M" || final === "m")) {
    return [parseMouse(params.slice(1), final === "m"), end + 1];
  }
  if (params === "200" && final === "~") {
    const stop = "\x1b[201~";
    const i = b.indexOf(stop, end + 1);
    if (i < 0) return [null, 0];
    return [{ kind: "paste", text: b.toString("utf8", end + 1, i) }, i + stop.length];
  }
  if (final >= "A" && final <= "D") return [arrow(b[end]), end + 1];
  return [null, end + 1];
}

function arrow(c: number): Key | null {
  switch (String.fromCharCode(c)) {
    case "A":
      return named("up");
    case "B":
      return named("down");
    case "C":
      return named("right");
    case "D":
      return named("left");
  }
  return null;
}

function parseMouse(params: string, release: boolean): Mouse | null {
  const parts = params.split(";");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const [b, x, y] = parts.map(Number);
  return { kind: "mouse", button: b & ~(4 | 8 | 16 | 32), x: x - 1, y: y - 1, release, motion: (b & 32) !== 0 };
}
