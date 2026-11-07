// Draws frames with the kitty graphics protocol.
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "./term";

// Image is raw pixels: 24 for RGB or 32 for RGBA in format.
export type Image = { pix: Uint8Array; format: number; width: number; height: number };

const recent: string[] = [];

// writeTemp writes pixels to a temporary file for place. The terminal deletes
// the file once it has read it.
export function writeTemp(pix: Uint8Array): string {
  const path = join(tmpdir(), `tty-graphics-protocol-rexsim-${randomBytes(6).toString("hex")}.raw`);
  writeFileSync(path, pix, { flag: "wx", mode: 0o600 });
  recent.push(path);
  if (recent.length > 32) recent.shift();
  return path;
}

// removeTemps removes the recent files that the terminal hasn't read, for
// example because rexsim quit before the terminal caught up.
export function removeTemps(): void {
  for (const path of recent.splice(0)) {
    try {
      unlinkSync(path);
    } catch {}
  }
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

  // draw places an image over the cell box at (col, row), scaled to fill cols
  // by rows cells. Images with a lower z sit under those with a higher one.
  draw(t: Terminal, img: Image, col: number, row: number, cols: number, rows: number, z: number): void {
    this.place(t, writeTemp(img.pix), img.format, img.width, img.height, col, row, cols, rows, z);
  }

  // place shows an image that writeTemp wrote, as draw does.
  place(t: Terminal, path: string, format: number, width: number, height: number, col: number, row: number, cols: number, rows: number, z: number): void {
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
}

// Sprites keeps one look's images in the terminal, such as a border in
// each of its colours, so showing one again sends no pixels. Its two image
// ids are base+1 and base+2. A new look frees the images of the old one.
export class Sprites {
  base = 0;
  private look = "";
  private ids = new Map<string, number>();
  private shown = 0;

  // show places the image for variant over the cell box at (col, row),
  // sending it with make the first time. Like Placer, it shows the new
  // placement before removing the old one.
  show(t: Terminal, look: string, variant: string, make: () => Image, col: number, row: number, cols: number, rows: number, z: number): void {
    if (look !== this.look || (!this.ids.has(variant) && this.ids.size === 2)) this.free(t, look);
    let id = this.ids.get(variant);
    if (id === undefined) {
      id = this.base + this.ids.size + 1;
      this.ids.set(variant, id);
      const img = make();
      const path = writeTemp(img.pix);
      t.write(`\x1b_Ga=t,q=2,f=${img.format},t=t,s=${img.width},v=${img.height},i=${id};${Buffer.from(path).toString("base64")}\x1b\\`);
    }
    t.write(`\x1b[${row + 1};${col + 1}H\x1b_Ga=p,q=2,i=${id},p=1,c=${cols},r=${rows},z=${z},C=1\x1b\\`);
    if (this.shown !== 0 && this.shown !== id) t.write(`\x1b_Ga=d,d=i,q=2,i=${this.shown}\x1b\\`);
    this.shown = id;
  }

  // delete hides the image shown, keeping the images to show again.
  delete(t: Terminal): void {
    if (this.shown === 0) return;
    t.write(`\x1b_Ga=d,d=i,q=2,i=${this.shown}\x1b\\`);
    this.shown = 0;
  }

  // clear frees every image, for a phone that goes away.
  clear(t: Terminal): void {
    this.free(t, "");
  }

  private free(t: Terminal, look: string): void {
    for (const id of this.ids.values()) t.write(`\x1b_Ga=d,d=I,q=2,i=${id}\x1b\\`);
    this.ids.clear();
    this.shown = 0;
    this.look = look;
  }
}
