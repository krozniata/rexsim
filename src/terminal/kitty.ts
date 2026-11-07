// Draws frames with the kitty graphics protocol.
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "./term";

// Image is raw pixels: 24 for RGB or 32 for RGBA in format.
export type Image = { pix: Uint8Array; format: number; width: number; height: number };

// writeTemp writes pixels to a temporary file for place. The terminal deletes
// the file once it has read it.
export function writeTemp(pix: Uint8Array): string {
  const path = join(tmpdir(), `tty-graphics-protocol-rexsim-${randomBytes(6).toString("hex")}.raw`);
  writeFileSync(path, pix, { flag: "wx", mode: 0o600 });
  return path;
}

export function removeTemp(path: string): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {}
}

export function clearAll(t: Terminal): void {
  t.write("\x1b_Ga=d,d=A,q=2\x1b\\");
}

// Placer sends each frame as a temporary file (t=t) rather than inline base64
// data, so Rex reads the pixels from disk and deletes the file. It alternates
// two image ids, base+1 and base+2, and deletes the old one only after the
// new one is placed, so a frame never goes blank in between.
export class Placer {
  base = 0;
  private shown = 0;
  private pending: string[] = [];

  // draw places an image over the cell box at (col, row), scaled to fill cols
  // by rows cells. Images with a lower z sit under those with a higher one.
  draw(t: Terminal, img: Image, col: number, row: number, cols: number, rows: number, z: number): void {
    this.place(t, writeTemp(img.pix), img.format, img.width, img.height, col, row, cols, rows, z);
  }

  // place shows an image that writeTemp wrote, as draw does.
  place(t: Terminal, path: string, format: number, width: number, height: number, col: number, row: number, cols: number, rows: number, z: number): void {
    this.track(path);
    const id = this.shown === this.base + 1 ? this.base + 2 : this.base + 1;
    const payload = Buffer.from(path).toString("base64");
    t.write(`\x1b[${row + 1};${col + 1}H\x1b_Ga=T,q=2,f=${format},t=t,s=${width},v=${height},i=${id},p=1,c=${cols},r=${rows},z=${z},C=1;${payload}\x1b\\`);
    if (this.shown !== 0) t.write(`\x1b_Ga=d,d=I,q=2,i=${this.shown}\x1b\\`);
    this.shown = id;
  }

  isShown(): boolean {
    return this.shown !== 0;
  }

  delete(t: Terminal): void {
    if (this.shown === 0) return;
    t.write(`\x1b_Ga=d,d=I,q=2,i=${this.shown}\x1b\\`);
    this.shown = 0;
  }

  // track remembers recent files so close can remove any the terminal didn't
  // read, for example because rexsim quit before the terminal caught up.
  private track(path: string): void {
    this.pending.push(path);
    if (this.pending.length > 8) this.pending.shift();
  }

  close(): void {
    this.pending.forEach(removeTemp);
  }
}
