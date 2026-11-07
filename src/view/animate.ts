import type { Image } from "../terminal/kitty";
import type { App } from "./app";
import type { Box } from "./layout";
import type { Phone } from "./phone";
import { thumbnail } from "./shapes";
import { drawSidebar, panelCol } from "./sidebar";

const animDuration = 200;
const animStep = 16;
const animThumbHeight = 360;

// animate applies a change to the layout and glides the phones that stay on
// screen from their old boxes to their new ones. Rex accepts moving a placed
// image (a=p) but doesn't redraw for it, so each step sends a small copy of
// the phone's last frame, the way video frames are sent. Borders, captions
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
      thumbs.set(p, thumbnail(p.current.pix, p.current.format, p.current.width, p.current.height, animThumbHeight));
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
        const b = lerpBox(before.get(p)!, p.box, e);
        p.placer.draw(a.t, thumbs.get(p)!, b.col, b.row, b.cols, b.rows, 0);
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

function lerpBox(from: Box, to: Box, t: number): Box {
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  return { col: lerp(from.col, to.col), row: lerp(from.row, to.row), cols: lerp(from.cols, to.cols), rows: lerp(from.rows, to.rows), x: 0, y: 0, w: 0, h: 0 };
}
