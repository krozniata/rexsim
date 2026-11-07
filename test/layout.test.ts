import { describe, expect, test } from "bun:test";
import { cellHeight, cellWidth, type Size } from "../src/terminal/term";
import { captionRows, computeLayout, computeSoloLayout, footerRows, gapCols, type Placement } from "../src/view/layout";

const iPhone = 1206 / 2622;
const iPad = 1640 / 2360;

const pane = (cols: number, rows: number): Size => ({ cols, rows, width: cols * 15, height: rows * 29 });

// checkLayout checks what every layout must hold: each phone inside the pane
// between the header and footer, its screen inside its frame, the screen's
// shape within a cell of the phone's, and no frames overlapping.
function checkLayout(s: Size, aspects: number[], pls: Placement[] | null): Placement[] {
  expect(pls).not.toBeNull();
  expect(pls!.length).toBe(aspects.length);
  const cw = cellWidth(s);
  const ch = cellHeight(s);
  pls!.forEach(({ frame: f, box: b }, i) => {
    expect(f.col >= 0 && f.col + f.cols <= s.cols && f.row >= 1 && f.row + f.rows <= s.rows - footerRows).toBe(true);
    expect([b.col, b.row, b.cols, b.rows]).toEqual([f.col + 1, f.row + 1, f.cols - 2, f.rows - 2 - captionRows]);
    const ar = aspects[i];
    expect(Math.abs(b.cols * cw - b.rows * ch * ar)).toBeLessThanOrEqual(cw + ch * ar);
    for (const { frame: g } of pls!.slice(0, i)) {
      expect(f.col < g.col + g.cols && g.col < f.col + f.cols && f.row < g.row + g.rows && g.row < f.row + f.rows).toBe(false);
    }
  });
  return pls!;
}

const rows = (pls: Placement[]) => new Set(pls.map((pl) => pl.frame.row)).size;

describe("computeLayout", () => {
  test("uses a grid in a wide pane", () => {
    const s = pane(119, 71);
    const aspects = [iPhone, iPhone, iPhone, iPhone];
    expect(rows(checkLayout(s, aspects, computeLayout(s, aspects)))).toBe(2);
  });

  test("picks a row or a column for the pane", () => {
    const aspects = [iPhone, iPhone, iPhone];
    let s = pane(180, 50);
    const row = checkLayout(s, aspects, computeLayout(s, aspects));
    expect(rows(row)).toBe(1);
    for (let i = 1; i < row.length; i++) {
      expect(row[i].frame.col - (row[i - 1].frame.col + row[i - 1].frame.cols)).toBe(gapCols);
    }
    s = pane(60, 200);
    expect(rows(checkLayout(s, aspects, computeLayout(s, aspects)))).toBe(3);
  });

  test("centres a part-filled last row", () => {
    const s = pane(90, 100);
    const aspects = [iPhone, iPhone, iPhone];
    const pls = checkLayout(s, aspects, computeLayout(s, aspects));
    expect(rows(pls)).toBe(2);
    const last = pls[2].frame;
    expect(Math.abs(last.col + last.cols / 2 - s.cols / 2)).toBeLessThanOrEqual(1);
  });

  test("draws the same model at the same size", () => {
    const s = pane(119, 71);
    const aspects = [iPad, iPhone, iPhone, iPhone];
    const pls = checkLayout(s, aspects, computeLayout(s, aspects));
    for (let i = 2; i < pls.length; i++) {
      expect([pls[i].box.cols, pls[i].box.rows]).toEqual([pls[1].box.cols, pls[1].box.rows]);
    }
  });

  test("gives up when nothing fits", () => {
    expect(computeLayout(pane(10, 5), [iPhone])).toBeNull();
    expect(computeLayout(pane(119, 71), [])).toBeNull();
  });
});

describe("computeSoloLayout", () => {
  test("puts the others in a column beside the focused phone in a wide pane", () => {
    const s = pane(200, 71);
    const pls = checkLayout(s, [iPhone, iPhone, iPad], computeSoloLayout(s, iPhone, [iPhone, iPad]));
    const [main, ...thumbs] = pls;
    expect(main.box.h).toBe(computeLayout(s, [iPhone])![0].box.h);
    for (const t of thumbs) {
      expect(t.box.h).toBeLessThan(main.box.h / 3);
      expect(t.frame.col).toBeGreaterThanOrEqual(main.frame.col + main.frame.cols);
    }
  });

  test("puts the others at the right in a narrow pane too", () => {
    const s = pane(60, 71);
    const pls = checkLayout(s, [iPhone, iPhone, iPhone], computeSoloLayout(s, iPhone, [iPhone, iPhone]));
    const [main, ...thumbs] = pls;
    for (const t of thumbs) expect(t.frame.col).toBeGreaterThanOrEqual(main.frame.col + main.frame.cols);
  });

  test("leaves out the thumbnails that don't fit", () => {
    const s = pane(60, 71);
    const rest = new Array(12).fill(iPhone);
    const pls = computeSoloLayout(s, iPhone, rest)!;
    const shown = pls.slice(1).filter((pl) => pl.box.cols > 0);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(12);
    checkLayout(s, [iPhone, ...shown.map(() => iPhone)], [pls[0], ...shown]);
  });

  test("shows the focused phone alone when the pane is too small for thumbnails", () => {
    const s = pane(119, 9);
    const pls = computeSoloLayout(s, iPhone, [iPhone])!;
    expect(pls[1].box.cols).toBe(0);
    expect(pls[0]).toEqual(computeLayout(s, [iPhone])![0]);
  });
});
