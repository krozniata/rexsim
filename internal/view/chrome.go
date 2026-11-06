package view

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"rexsim/internal/kitty"
)

const statusTime = 4 * time.Second

func (a *app) drawChrome() {
	s := a.size
	if s.Rows < 4 || s.Cols < 20 || a.focus == nil {
		return
	}
	a.beginSync()
	a.drawHeader()
	for _, p := range a.visible() {
		a.drawFrame(p)
	}
	a.drawFooter()
	a.t.WriteString("\x1b[0m")
	a.endSync()
}

// beginSync and endSync bracket output that the terminal should show at
// once (mode 2026). They nest, so a whole relayout lands as one update
// rather than flashing blank between its parts.
func (a *app) beginSync() {
	if a.syncs == 0 {
		a.t.WriteString("\x1b[?2026h")
	}
	a.syncs++
}

func (a *app) endSync() {
	a.syncs--
	if a.syncs == 0 {
		a.t.WriteString("\x1b[?2026l")
		_ = a.t.Flush()
	}
}

func width(s string) int { return utf8.RuneCountInString(s) }

func (a *app) drawHeader() {
	fmt.Fprintf(a.t, "\x1b[1;1H\x1b[0m\x1b[2K %s◆ rexsim", sgr(a.pal.accent, "1"))
	switch n := len(a.phones); {
	case a.solo && n > 1:
		fmt.Fprintf(a.t, "%s  %d of %d · focus", sgr(a.pal.dim), a.focusIndex()+1, n)
	case n > 1:
		fmt.Fprintf(a.t, "%s  %d simulators · %s", sgr(a.pal.dim), n, strings.ToLower(a.mode.String()))
	}
}

// drawFrame draws the phone's border, in the accent colour when it has the
// keyboard, and its caption below.
func (a *app) drawFrame(p *phone) {
	f := p.frame
	if f.cols < 3 {
		return
	}
	focused := p == a.focus && len(a.visible()) > 1
	a.drawBorder(p, focused)

	bottom := f.row + f.rows - 1 - captionRows
	room := f.cols + gapCols - 1
	var name, detail, nameStyle string
	switch {
	case p.failed != "":
		name, detail, nameStyle = p.device.Name, "  "+p.failed, sgr(a.pal.err, "1")
	case p.connecting && !p.device.Booted:
		name, detail, nameStyle = p.device.Name, "  booting…", sgr(a.pal.text, "1")
	case p.connecting:
		name, detail, nameStyle = p.device.Name, "  connecting…", sgr(a.pal.text, "1")
	default:
		name, detail, nameStyle = p.device.Name, "  iOS "+p.osVersion, sgr(a.pal.text, "1")
		if focused {
			nameStyle = sgr(a.pal.accent, "1")
		}
	}
	name = clip(name, room)
	detail = clip(detail, room-width(name))
	start := f.col + (f.cols-width(name)-width(detail))/2
	start = max(start, f.col-gapCols/2+1, 0)
	fmt.Fprintf(a.t, "\x1b[%d;%dH\x1b[0K%s%s%s%s\x1b[0m", bottom+2, start+1, nameStyle, name, sgr(a.pal.dim), detail)
}

// drawBorder draws a rounded outline around the phone as an image, because
// box-drawing characters can't round a corner by more than a cell. The
// outline sits a uniform gap outside the screen, and its radius is the
// screen's plus that gap, so the corners stay concentric. It is redrawn
// only when its look changes.
func (a *app) drawBorder(p *phone, focused bool) {
	color := a.pal.frame
	if focused {
		color = a.pal.accent
	}
	key := fmt.Sprintf("%v %s", p.frame, color)
	if key == p.borderKey {
		return
	}
	p.borderKey = key

	cw, ch := a.size.CellWidth(), a.size.CellHeight()
	f := p.frame
	rows := f.rows - captionRows
	w, h := int(math.Round(float64(f.cols)*cw)), int(math.Round(float64(rows)*ch))
	gap := 0.5 * min(cw, ch)
	stroke := max(1.5, math.Round(min(cw, ch)/8))
	b := p.box
	left, top := b.x-f.x-gap, b.y-f.y-gap
	right, bottom := left+b.w+2*gap, top+b.h+2*gap
	r := screenRadius(p.aspect())*b.w + gap
	img := kitty.Image{
		Pix:    roundedOutline(w, h, left, top, right, bottom, r, stroke, rgbOf(color)),
		Format: 32, Width: w, Height: h,
	}
	if err := p.border.Draw(a.t, img, f.col, f.row, f.cols, rows, -1); err != nil {
		a.flash(err.Error())
	}
}

func (a *app) drawFooter() {
	fmt.Fprintf(a.t, "\x1b[%d;1H\x1b[0m\x1b[2K", a.size.Rows)
	rate, rateStyle := "○ idle ", sgr(a.pal.dim)
	if a.fps > 0 {
		rate, rateStyle = fmt.Sprintf("● %d fps ", a.fps), sgr(a.pal.accent)
	}
	room := a.size.Cols - width(rate) - 2
	if time.Now().Before(a.statusUntil) {
		fmt.Fprintf(a.t, " %s%s", sgr(a.pal.accent), clip(a.status, room))
	} else {
		hints := [][2]string{{"⌃F", "focus"}, {"⌃N", "next"}, {"⌃O", "open"}, {"⌃W", "close"}, {"⌃B", "home"}, {"⌃L", "lock"}, {"⌃S", "screenshot"}, {"⌃G", "layout"}, {"⌃]", "quit"}}
		if len(a.phones) < 2 {
			hints = hints[2:]
		}
		used := 1
		a.t.WriteString(" ")
		for _, h := range hints {
			n := width(h[0]) + 1 + width(h[1]) + 3
			if used+n > room {
				break
			}
			fmt.Fprintf(a.t, "%s%s %s%s   ", sgr(a.pal.text, "1"), h[0], sgr(a.pal.dim), h[1])
			used += n
		}
	}
	fmt.Fprintf(a.t, "\x1b[%d;%dH%s%s", a.size.Rows, a.size.Cols-width(rate)+1, rateStyle, rate)
}

func clip(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:max(0, n-1)]) + "…"
}

func (a *app) flash(text string) {
	a.status = text
	a.statusUntil = time.Now().Add(statusTime)
	a.drawChrome()
}

func (a *app) report(err error) {
	if err != nil {
		a.flash(err.Error())
	}
}
