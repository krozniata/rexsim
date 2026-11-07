// Puts the terminal in raw mode and reads keys, mouse events and pastes
// from it.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { writeSync } from "node:fs";

const TIOCGWINSZ = 0x40087468;

// ioctl is variadic, and Apple's arm64 ABI passes variadic arguments on the
// stack rather than in registers. Six unused arguments fill the remaining
// registers, so argp lands in the first stack slot, where ioctl reads it.
const libc = dlopen("libc.dylib", {
  ioctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
});

// Size is the terminal's size in cells and in pixels.
export type Size = { cols: number; rows: number; width: number; height: number };

export function cellWidth(s: Size): number {
  return s.width === 0 ? 8 : s.width / s.cols;
}

export function cellHeight(s: Size): number {
  return s.height === 0 ? 16 : s.height / s.rows;
}

export class Terminal {
  private buf: string[] = [];
  private winsize = new Uint16Array(4);

  static open(): Terminal {
    process.stdin.setRawMode(true);
    const t = new Terminal();
    t.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    t.flush();
    return t;
  }

  write(s: string): void {
    this.buf.push(s);
  }

  // flush writes synchronously, so output keeps its order with the image
  // files it names. A tty that is busy reports EAGAIN; the rest is retried
  // after a millisecond rather than in a spin.
  flush(): void {
    if (this.buf.length === 0) return;
    let data = Buffer.from(this.buf.join(""));
    this.buf = [];
    while (data.length > 0) {
      try {
        data = data.subarray(writeSync(1, data));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
        Bun.sleepSync(1);
      }
    }
  }

  // enableInput turns on mouse reporting in pixels (1016) rather than cells,
  // so a click maps to an exact point on the phone, and bracketed paste.
  enableInput(): void {
    this.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1016h\x1b[?2004h");
    this.flush();
  }

  close(): void {
    this.write("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?2004l\x1b[?1016l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    this.flush();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  size(): Size {
    const ws = this.winsize;
    if (libc.symbols.ioctl(0, TIOCGWINSZ, 0, 0, 0, 0, 0, 0, ptr(ws)) !== 0) throw new Error("can't read the terminal size");
    return { rows: ws[0], cols: ws[1], width: ws[2], height: ws[3] };
  }
}
