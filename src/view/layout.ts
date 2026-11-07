import { cellHeight, cellWidth, type Size } from "../terminal/term";

export const marginCols = 2;
export const gapCols = 4;
export const gapRows = 1;
export const captionRows = 1;
export const footerRows = 1;

export type Box = { col: number; row: number; cols: number; rows: number; x: number; y: number; w: number; h: number };

export const emptyBox: Box = { col: 0, row: 0, cols: 0, rows: 0, x: 0, y: 0, w: 0, h: 0 };

export function contains(b: Box, px: number, py: number): boolean {
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}

// Placement is where one phone goes: its frame, which includes the caption
// below it, and the box its screen fills.
export type Placement = { frame: Box; box: Box };

const div = (a: number, b: number) => Math.trunc(a / b);

// computeLayout places phones of the given aspect ratios, width over height,
// each in a rounded frame with its caption below, with gaps between them. It
// tries every number of rows and keeps the one that draws the smallest phone
// biggest: side by side in a wide pane, stacked in a tall one. It centres
// every row of the grid, so a part-filled last row sits in the middle. The
// terminal scales images to whole cells, so a box can be off the phone's
// aspect ratio by up to a cell; touches map through the same box. It returns
// null when the phones don't fit.
export function computeLayout(s: Size, aspects: number[]): Placement[] | null {
  const cw = cellWidth(s);
  const ch = cellHeight(s);
  const availCols = s.cols - 2 * marginCols;
  const availRows = s.rows - 3 - footerRows;
  const n = aspects.length;
  if (n === 0) return null;

  type Cells = { cols: number; rows: number };
  // fitIn sizes each phone to fill its own cell of a grid with r rows, and
  // reports the height of the smallest one.
  const fitIn = (r: number): [Cells[], number] | null => {
    const c = div(n + r - 1, r);
    const innerCols = div(availCols - (c - 1) * gapCols, c) - 2;
    const innerRows = div(availRows - (r - 1) * gapRows, r) - 2 - captionRows;
    if (innerCols < 1 || innerRows < 1) return null;
    let smallest = Infinity;
    const sizes = aspects.map((ar) => {
      const h = Math.min(innerRows * ch, (innerCols * cw) / ar);
      smallest = Math.min(smallest, h);
      return {
        cols: Math.min(innerCols, Math.max(1, Math.round((h * ar) / cw))),
        rows: Math.min(innerRows, Math.max(1, Math.round(h / ch))),
      };
    });
    return [sizes, smallest];
  };
  let sizes: Cells[] = [];
  let bestH = 0;
  let bestR = 0;
  for (let r = 1; r <= n; r++) {
    const fit = fitIn(r);
    if (fit && fit[1] > bestH) [sizes, bestH, bestR] = [fit[0], fit[1], r];
  }
  if (bestR === 0) return null;

  const c = div(n + bestR - 1, bestR);
  const heights = new Array<number>(bestR).fill(0);
  let totalH = gapRows * (bestR - 1);
  for (let row = 0; row < bestR; row++) {
    for (let i = row * c; i < Math.min(n, (row + 1) * c); i++) {
      heights[row] = Math.max(heights[row], sizes[i].rows + 2 + captionRows);
    }
    totalH += heights[row];
  }
  const cells = (col: number, row: number, cols: number, rows: number): Box => ({
    col, row, cols, rows, x: col * cw, y: row * ch, w: cols * cw, h: rows * ch,
  });
  const out: Placement[] = new Array(n);
  let y = 2 + Math.max(0, div(availRows - totalH, 2));
  heights.forEach((height, row) => {
    const first = row * c;
    const last = Math.min(n, (row + 1) * c);
    let width = gapCols * (last - first - 1);
    for (let i = first; i < last; i++) width += sizes[i].cols + 2;
    let x = marginCols + Math.max(0, div(availCols - width, 2));
    for (let i = first; i < last; i++) {
      const sz = sizes[i];
      const top = y + div(height - (sz.rows + 2 + captionRows), 2);
      out[i] = {
        frame: cells(x, top, sz.cols + 2, sz.rows + 2 + captionRows),
        box: cells(x + 1, top + 1, sz.cols, sz.rows),
      };
      x += sz.cols + 2 + gapCols;
    }
    y += height + gapRows;
  });
  return out;
}
