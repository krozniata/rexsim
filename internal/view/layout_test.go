package view

import (
	"math"
	"testing"

	"rexsim/internal/term"
)

const (
	iPhone = 1206.0 / 2622
	iPad   = 1640.0 / 2360
)

func pane(cols, rows int) term.Size {
	return term.Size{Cols: cols, Rows: rows, Width: cols * 15, Height: rows * 29}
}

// checkLayout checks what every layout must hold: each phone inside the pane
// between the header and footer, its screen inside its frame, the screen's
// shape within a cell of the phone's, and no frames overlapping.
func checkLayout(t *testing.T, s term.Size, aspects []float64, pls []placement) {
	t.Helper()
	if len(pls) != len(aspects) {
		t.Fatalf("got %d placements for %d phones", len(pls), len(aspects))
	}
	cw, ch := s.CellWidth(), s.CellHeight()
	for i, pl := range pls {
		f, b := pl.frame, pl.box
		if f.col < 0 || f.col+f.cols > s.Cols || f.row < 1 || f.row+f.rows > s.Rows-1 {
			t.Errorf("phone %d: frame %+v is outside the pane", i, f)
		}
		if b.col != f.col+1 || b.row != f.row+1 || b.cols != f.cols-2 || b.rows != f.rows-2-captionRows {
			t.Errorf("phone %d: screen %+v doesn't sit in frame %+v", i, b, f)
		}
		ar := aspects[i]
		if d := math.Abs(float64(b.cols)*cw - float64(b.rows)*ch*ar); d > cw+ch*ar {
			t.Errorf("phone %d: screen %d×%d cells is off its aspect %.2f by %.0f px", i, b.cols, b.rows, ar, d)
		}
		for j := range i {
			g := pls[j].frame
			if f.col < g.col+g.cols && g.col < f.col+f.cols && f.row < g.row+g.rows && g.row < f.row+f.rows {
				t.Errorf("phones %d and %d overlap: %+v and %+v", j, i, g, f)
			}
		}
	}
}

func rows(pls []placement) map[int]bool {
	seen := map[int]bool{}
	for _, pl := range pls {
		seen[pl.frame.row] = true
	}
	return seen
}

func TestLayoutAutoUsesAGridInAWidePane(t *testing.T) {
	s, aspects := pane(119, 71), []float64{iPhone, iPhone, iPhone, iPhone}
	pls := computeLayout(s, aspects, layoutAuto)
	checkLayout(t, s, aspects, pls)
	if len(rows(pls)) != 2 {
		t.Errorf("want 2 rows of phones, got %d", len(rows(pls)))
	}
}

func TestLayoutRowAndColumn(t *testing.T) {
	aspects := []float64{iPhone, iPhone, iPhone}
	s := pane(180, 50)
	row := computeLayout(s, aspects, layoutRow)
	checkLayout(t, s, aspects, row)
	if len(rows(row)) != 1 {
		t.Errorf("row: phones on %d rows", len(rows(row)))
	}
	for i := 1; i < len(row); i++ {
		if gap := row[i].frame.col - (row[i-1].frame.col + row[i-1].frame.cols); gap != gapCols {
			t.Errorf("row: gap %d between phones %d and %d, want %d", gap, i-1, i, gapCols)
		}
	}

	s = pane(60, 200)
	col := computeLayout(s, aspects, layoutColumn)
	checkLayout(t, s, aspects, col)
	if len(rows(col)) != 3 {
		t.Errorf("column: phones on %d rows, want 3", len(rows(col)))
	}
}

func TestLayoutGridCentresAPartFilledLastRow(t *testing.T) {
	s, aspects := pane(119, 71), []float64{iPhone, iPhone, iPhone}
	pls := computeLayout(s, aspects, layoutGrid)
	checkLayout(t, s, aspects, pls)
	last := pls[2].frame
	centre := float64(last.col) + float64(last.cols)/2
	if math.Abs(centre-float64(s.Cols)/2) > 1 {
		t.Errorf("last phone centred at column %.1f, want %.1f", centre, float64(s.Cols)/2)
	}
}

func TestLayoutDrawsTheSameModelAtTheSameSize(t *testing.T) {
	s, aspects := pane(119, 71), []float64{iPad, iPhone, iPhone, iPhone}
	pls := computeLayout(s, aspects, layoutAuto)
	checkLayout(t, s, aspects, pls)
	for i := 2; i < len(pls); i++ {
		if pls[i].box.cols != pls[1].box.cols || pls[i].box.rows != pls[1].box.rows {
			t.Errorf("iPhone %d is %d×%d, iPhone 1 is %d×%d", i, pls[i].box.cols, pls[i].box.rows, pls[1].box.cols, pls[1].box.rows)
		}
	}
}

func TestLayoutGivesUpWhenNothingFits(t *testing.T) {
	if pls := computeLayout(pane(10, 5), []float64{iPhone}, layoutAuto); pls != nil {
		t.Errorf("want nil in a tiny pane, got %+v", pls)
	}
	if pls := computeLayout(pane(119, 71), nil, layoutAuto); pls != nil {
		t.Errorf("want nil with no phones, got %+v", pls)
	}
}
