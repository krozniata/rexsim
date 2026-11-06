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
)

type layoutMode int

const (
	layoutAuto layoutMode = iota
	layoutGrid
	layoutRow
	layoutColumn
)

func (m layoutMode) String() string {
	return [...]string{"Auto", "Grid", "Row", "Column"}[m]
}

// rowChoices lists the numbers of rows the layout mode allows. Auto tries
// them all and keeps the one that draws the phones biggest: side by side in a
// wide pane, stacked in a tall one.
func rowChoices(mode layoutMode, n int) []int {
	switch mode {
	case layoutRow:
		return []int{1}
	case layoutColumn:
		return []int{n}
	case layoutGrid:
		c := int(math.Ceil(math.Sqrt(float64(n))))
		return []int{(n + c - 1) / c}
	}
	rows := make([]int, n)
	for i := range rows {
		rows[i] = i + 1
	}
	return rows
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
	for i, pl := range computeLayout(a.size, aspects, a.mode) {
		shown[i].frame, shown[i].box = pl.frame, pl.box
	}
}

// placement is where one phone goes: its frame, which includes the caption
// below it, and the box its screen fills.
type placement struct{ frame, box box }

// computeLayout places phones of the given aspect ratios, width over height,
// each in a rounded frame with its caption below, with gaps between them. It
// centres every row of the grid, so a part-filled last row sits in the
// middle. The terminal scales images to whole cells, so a box can be off the
// phone's aspect ratio by up to a cell; touches map through the same box. It
// returns nil when the phones don't fit.
func computeLayout(s term.Size, aspects []float64, mode layoutMode) []placement {
	cw, ch := s.CellWidth(), s.CellHeight()
	availCols, availRows := s.Cols-2*marginCols, s.Rows-4
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
	pick := func(choices []int) {
		for _, r := range choices {
			if s, h, ok := fitIn(r); ok && h > bestH {
				sizes, bestH, bestR = s, h, r
			}
		}
	}
	pick(rowChoices(mode, n))
	if bestR == 0 {
		pick(rowChoices(layoutAuto, n))
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
