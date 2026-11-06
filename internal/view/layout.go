package view

import (
	"math"

	"rexsim/internal/term"
)

const (
	marginCols  = 2
	gapCols     = 4
	gapRows     = 1
	captionRows = 1
	footerRows  = 1
)

// phoneArea is the part of the pane the phones use: all of it, or what the
// sidebar leaves.
func (a *app) phoneArea() term.Size {
	s := a.size
	if a.sidebar != nil {
		s.Cols = a.panelCol()
		s.Width = int(float64(s.Cols) * a.size.CellWidth())
	}
	return s
}

func (a *app) layout() {
	for _, p := range a.phones {
		p.frame, p.box = box{}, box{}
	}
	shown := a.visible()
	aspects := make([]float64, len(shown))
	for i, p := range shown {
		aspects[i] = p.aspect()
	}
	for i, pl := range computeLayout(a.phoneArea(), aspects) {
		shown[i].frame, shown[i].box = pl.frame, pl.box
	}
}

// placement is where one phone goes: its frame, which includes the caption
// below it, and the box its screen fills.
type placement struct{ frame, box box }

// computeLayout places phones of the given aspect ratios, width over height,
// each in a rounded frame with its caption below, with gaps between them. It
// tries every number of rows and keeps the one that draws the smallest phone
// biggest: side by side in a wide pane, stacked in a tall one. It
// centres every row of the grid, so a part-filled last row sits in the
// middle. The terminal scales images to whole cells, so a box can be off the
// phone's aspect ratio by up to a cell; touches map through the same box. It
// returns nil when the phones don't fit.
func computeLayout(s term.Size, aspects []float64) []placement {
	cw, ch := s.CellWidth(), s.CellHeight()
	availCols, availRows := s.Cols-2*marginCols, s.Rows-3-footerRows
	n := len(aspects)
	if n == 0 {
		return nil
	}

	type size struct{ cols, rows int }
	// fitIn sizes each phone to fill its own cell of a grid with r rows, and
	// reports the height of the smallest one.
	fitIn := func(r int) ([]size, float64, bool) {
		c := (n + r - 1) / r
		innerCols := (availCols-(c-1)*gapCols)/c - 2
		innerRows := (availRows-(r-1)*gapRows)/r - 2 - captionRows
		if innerCols < 1 || innerRows < 1 {
			return nil, 0, false
		}
		sizes := make([]size, n)
		smallest := math.Inf(1)
		for i, ar := range aspects {
			h := min(float64(innerRows)*ch, float64(innerCols)*cw/ar)
			sizes[i] = size{
				cols: min(innerCols, max(1, int(math.Round(h*ar/cw)))),
				rows: min(innerRows, max(1, int(math.Round(h/ch)))),
			}
			smallest = min(smallest, h)
		}
		return sizes, smallest, true
	}
	var sizes []size
	bestH, bestR := 0.0, 0
	for r := 1; r <= n; r++ {
		if s, h, ok := fitIn(r); ok && h > bestH {
			sizes, bestH, bestR = s, h, r
		}
	}
	if bestR == 0 {
		return nil
	}

	c := (n + bestR - 1) / bestR
	heights := make([]int, bestR)
	totalH := gapRows * (bestR - 1)
	for row := range heights {
		for i := row * c; i < min(n, (row+1)*c); i++ {
			heights[row] = max(heights[row], sizes[i].rows+2+captionRows)
		}
		totalH += heights[row]
	}
	cells := func(col, row, cols, rows int) box {
		return box{col: col, row: row, cols: cols, rows: rows,
			x: float64(col) * cw, y: float64(row) * ch, w: float64(cols) * cw, h: float64(rows) * ch}
	}
	out := make([]placement, n)
	y := 2 + max(0, (availRows-totalH)/2)
	for row, height := range heights {
		first, last := row*c, min(n, (row+1)*c)
		width := gapCols * (last - first - 1)
		for i := first; i < last; i++ {
			width += sizes[i].cols + 2
		}
		x := marginCols + max(0, (availCols-width)/2)
		for i := first; i < last; i++ {
			sz := sizes[i]
			top := y + (height-(sz.rows+2+captionRows))/2
			out[i] = placement{
				frame: cells(x, top, sz.cols+2, sz.rows+2+captionRows),
				box:   cells(x+1, top+1, sz.cols, sz.rows),
			}
			x += sz.cols + 2 + gapCols
		}
		y += height + gapRows
	}
	return out
}
