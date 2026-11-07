import { cellHeight, cellWidth, type Size } from "../terminal/term";

export const marginCols = 2;
export const gapCols = 4;
export const gapRows = 1;
export const captionRows = 2;
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
        frame: cellBox(s, x, top, sz.cols + 2, sz.rows + 2 + captionRows),
        box: cellBox(s, x + 1, top + 1, sz.cols, sz.rows),
      };
      x += sz.cols + 2 + gapCols;
    }
    y += height + gapRows;
  });
  return out;
}

// thumbShare is the height of a thumbnail's screen as a share of the pane's.
const thumbShare = 0.15;
const minThumbRows = 3;

// computeSoloLayout places the focused phone, of aspect focus, with the
// other phones, of aspects rest, small in a column at the right. Thumbnails
// that don't fit get an empty box, and so do all of them when the pane is
// too small for the column.
export function computeSoloLayout(s: Size, focus: number, rest: number[]): Placement[] | null {
  const alone = computeLayout(s, [focus]);
  if (!alone) return null;
  return (rest.length > 0 && sideLayout(s, focus, rest)) || [alone[0], ...rest.map(() => ({ frame: emptyBox, box: emptyBox }))];
}

const thumbRows = (s: Size) => Math.max(minThumbRows, Math.round(s.rows * thumbShare));

function thumbCols(s: Size, inner: number, ar: number): number {
  return Math.max(1, Math.round((inner * cellHeight(s) * ar) / cellWidth(s)));
}

function cellBox(s: Size, col: number, row: number, cols: number, rows: number): Box {
  const cw = cellWidth(s);
  const ch = cellHeight(s);
  return { col, row, cols, rows, x: col * cw, y: row * ch, w: cols * cw, h: rows * ch };
}

function thumb(s: Size, col: number, row: number, cols: number, inner: number): Placement {
  return { frame: cellBox(s, col, row, cols + 2, inner + 2 + captionRows), box: cellBox(s, col + 1, row + 1, cols, inner) };
}

// sideLayout stacks the thumbnails in a column at the right, as many as fit
// the pane's height, and centres the focused phone in what is left.
function sideLayout(s: Size, focus: number, rest: number[]): Placement[] | null {
  const inner = thumbRows(s);
  const column = Math.max(...rest.map((ar) => thumbCols(s, inner, ar))) + 2;
  const mainCols = s.cols - column - gapCols;
  if (mainCols < 2 * marginCols + 3) return null;
  const main = computeLayout({ ...s, cols: mainCols, width: mainCols * cellWidth(s) }, [focus]);
  if (!main) return null;
  const availRows = s.rows - 3 - footerRows;
  const tall = inner + 2 + captionRows;
  const shown = Math.min(rest.length, div(availRows + gapRows, tall + gapRows));
  if (shown === 0) return null;
  let y = 2 + Math.max(0, div(availRows - (shown * (tall + gapRows) - gapRows), 2));
  const right = s.cols - marginCols;
  return [
    main[0],
    ...rest.map((ar, i) => {
      if (i >= shown) return { frame: emptyBox, box: emptyBox };
      const cols = thumbCols(s, inner, ar);
      const pl = thumb(s, right - column + div(column - cols - 2, 2), y, cols, inner);
      y += tall + gapRows;
      return pl;
    }),
  ];
}
