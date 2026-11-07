import type { Image } from "../terminal/kitty";
import type { App } from "./app";
import type { Box } from "./layout";
import type { Phone } from "./phone";
import { cellHeight, cellWidth } from "../terminal/term";
import { blur, inCanvas, thumbnail } from "./shapes";
import type { RGB } from "./theme";
import { drawSidebar, panelCol } from "./sidebar";

const animDuration = 200;
const animStep = 16;
const animThumbHeight = 720;
const animBlur = 1;

// animate applies a change to the layout and glides the phones that stay on
// screen from their old boxes to their new ones. Rex accepts moving a placed
// image (a=p) but doesn't redraw for it, so each step sends a small copy of
// the phone's last frame, the way video frames are sent. A step moves and
// sizes the copy in pixels, not whole cells: it draws it at its exact spot
// on a canvas the size of the cells around it, which the terminal stretches
// to those cells. The copy blurs most in the middle of the move and not at
// all at its ends, which hides its low resolution. Borders, captions
// and the phones that leave are hidden while they move, and the sidebar
// slides with them; relayout draws everything sharp at the end.
export async function animate(a: App, change: () => void): Promise<void> {
  const before = new Map<Phone, Box>();
  for (const p of a.visible()) if (p.box.cols > 0 && p.placer.isShown()) before.set(p, p.box);
  let panel = a.sidebar;
  const panelFrom = panelCol(a);
  change();
  a.layout();
  panel ??= a.sidebar;
  const panelTo = panelCol(a);
  const movers: Phone[] = [];
  const thumbs = new Map<Phone, Image>();
  for (const p of a.visible()) {
    if (before.has(p) && p.box.cols > 0 && p.current) {
      movers.push(p);
      thumbs.set(p, thumbnail(p.current.pix, p.current.width, p.current.height, animThumbHeight));
    }
  }
  if (movers.length === 0 && panelFrom === panelTo) {
    a.relayout();
    return;
  }

  a.beginSync();
  for (const p of before.keys()) {
    p.border.delete(a.t);
    if (p.box.cols === 0 || !a.phones.includes(p)) p.placer.delete(a.t);
  }
  a.t.write("\x1b[0m\x1b[2J");
  a.endSync();

  const start = performance.now();
  let panelAt = panelFrom;
  for (;;) {
    const t = Math.min(1, (performance.now() - start) / animDuration);
    const e = 1 - (1 - t) ** 3;
    let failed: Error | null = null;
    a.beginSync();
    try {
      for (const p of movers) {
        const soft = blur(thumbs.get(p)!, Math.round(animBlur * Math.sin(Math.PI * t)));
        const s = step(soft, before.get(p)!, p.box, e, cellWidth(a.size), cellHeight(a.size), a.background);
        p.placer.draw(a.t, s.img, s.col, s.row, s.cols, s.rows, 0);
      }
      if (panel) {
        const col = Math.round(panelFrom + (panelTo - panelFrom) * e);
        drawSidebar(a, panel, col, Math.min(col, panelAt));
        panelAt = col;
      }
    } catch (err) {
      failed = err as Error;
    } finally {
      a.endSync();
    }
    if (failed) a.flash(failed.message);
    if (failed || t >= 1) break;
    await Bun.sleep(animStep);
  }
  a.relayout();
}

// step places img, the copy of a phone, a fraction t of the way from box
// from to box to, keeping its shape.
function step(img: Image, from: Box, to: Box, t: number, cw: number, ch: number, fill: RGB) {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const h = lerp(from.h, to.h);
  const w = (h * img.width) / img.height;
  const x = lerp(from.x + from.w / 2, to.x + to.w / 2) - w / 2;
  const y = lerp(from.y, to.y);
  const col = Math.max(0, Math.floor(x / cw));
  const row = Math.max(0, Math.floor(y / ch));
  const cols = Math.max(1, Math.ceil((x + w) / cw) - col);
  const rows = Math.max(1, Math.ceil((y + h) / ch) - row);
  // k is the copy's pixels per screen pixel, so the canvas holds the copy
  // at its own size.
  const k = img.height / h;
  const canvas = inCanvas(img, Math.round(cols * cw * k), Math.round(rows * ch * k), Math.round((x - col * cw) * k), Math.round((y - row * ch) * k), fill);
  return { img: canvas, col, row, cols, rows };
}
