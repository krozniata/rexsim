package view

import (
	"math"
	"slices"
	"time"

	"rexsim/internal/kitty"
)

const (
	animDuration    = 200 * time.Millisecond
	animStep        = 16 * time.Millisecond
	animThumbHeight = 360
)

// animate applies a change to the layout and glides the phones that stay on
// screen from their old boxes to their new ones. Rex accepts moving a placed
// image (a=p) but doesn't redraw for it, so each step sends a small copy of
// the phone's last frame, the way video frames are sent. Borders, captions
// and the phones that leave are hidden while they move, and the sidebar
// slides with them; relayout draws everything sharp at the end.
func (a *app) animate(change func()) {
	before := map[*phone]box{}
	for _, p := range a.visible() {
		if p.box.cols > 0 && p.placer.Shown() {
			before[p] = p.box
		}
	}
	panel, panelFrom := a.sidebar, a.panelCol()
	change()
	a.layout()
	if panel == nil {
		panel = a.sidebar
	}
	panelTo := a.panelCol()
	var movers []*phone
	thumbs := map[*phone]kitty.Image{}
	for _, p := range a.visible() {
		if _, ok := before[p]; ok && p.box.cols > 0 && p.current != nil {
			movers = append(movers, p)
			thumbs[p] = thumbnail(p.current.rgba, p.current.width, p.current.height, animThumbHeight)
		}
	}
	if len(movers) == 0 && panelFrom == panelTo {
		a.relayout()
		return
	}

	a.beginSync()
	for p := range before {
		_ = p.border.Delete(a.t)
		if p.box.cols == 0 || !slices.Contains(a.phones, p) {
			_ = p.placer.Delete(a.t)
		}
	}
	a.t.WriteString("\x1b[0m\x1b[2J")
	a.endSync()

	start, panelAt := time.Now(), panelFrom
	for {
		t := min(1, float64(time.Since(start))/float64(animDuration))
		e := 1 - math.Pow(1-t, 3)
		a.beginSync()
		for _, p := range movers {
			b := lerpBox(before[p], p.box, e)
			_ = p.placer.Draw(a.t, thumbs[p], b.col, b.row, b.cols, b.rows, 0)
		}
		if panel != nil {
			col := int(math.Round(float64(panelFrom) + float64(panelTo-panelFrom)*e))
			a.drawSidebar(panel, col, min(col, panelAt))
			panelAt = col
		}
		a.endSync()
		if t >= 1 {
			break
		}
		time.Sleep(animStep)
	}
	a.relayout()
}

func lerpBox(from, to box, t float64) box {
	lerp := func(a, b int) int { return int(math.Round(float64(a) + (float64(b)-float64(a))*t)) }
	return box{col: lerp(from.col, to.col), row: lerp(from.row, to.row), cols: lerp(from.cols, to.cols), rows: lerp(from.rows, to.rows)}
}
