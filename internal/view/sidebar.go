package view

import (
	"fmt"
	"strings"

	"rexsim/internal/sim"
	"rexsim/internal/term"
)

const (
	sidebarCols = 34
	listTop     = 4
)

// sidebar lists every simulator beside the phones, to show or hide them.
type sidebar struct {
	devices     []sim.Device
	sel, offset int
}

// panelCol is the column where the sidebar starts, or the pane's width when
// it is closed.
func (a *app) panelCol() int {
	if a.sidebar == nil {
		return a.size.Cols
	}
	return max(0, a.size.Cols-sidebarCols)
}

// toggleSidebar slides the simulator list in from the right, or back out.
func (a *app) toggleSidebar() {
	if a.sidebar != nil {
		a.animate(func() { a.sidebar = nil })
		return
	}
	devices, err := sim.Devices(a.ctx)
	if err != nil {
		a.flash(err.Error())
		return
	}
	a.animate(func() { a.sidebar = &sidebar{devices: devices} })
}

func (a *app) phoneFor(udid string) *phone {
	for _, p := range a.phones {
		if p.device.UDID == udid {
			return p
		}
	}
	return nil
}

// toggleDevice shows the selected simulator, booting it if needed, or hides
// it and shuts it down, and slides the list away. Only one simulator starts
// at a time.
func (a *app) toggleDevice() {
	sb := a.sidebar
	if len(sb.devices) == 0 {
		return
	}
	d := sb.devices[sb.sel]
	if p := a.phoneFor(d.UDID); p != nil {
		if len(a.phones) == 1 {
			a.flash("Keep one simulator open, or quit with ⌃]")
			return
		}
		a.animate(func() {
			a.removePhone(p)
			a.sidebar = nil
		})
		return
	}
	for _, p := range a.phones {
		if p.connecting {
			a.flash("Wait for " + p.device.Name + " to start")
			return
		}
	}
	a.animate(func() {
		a.focus = a.add([]sim.Device{d})[0]
		a.sidebar = nil
	})
}

// markShutDown keeps the list's state in step when a phone closes.
func (a *app) markShutDown(udid string) {
	if a.sidebar == nil {
		return
	}
	for i := range a.sidebar.devices {
		if a.sidebar.devices[i].UDID == udid {
			a.sidebar.devices[i].Booted = false
		}
	}
}

// sidebarKey handles a key while the list is open and reports whether it
// did. The list takes the arrows, Space, Enter and typing, so they don't
// reach a phone by surprise; other shortcuts still work.
func (a *app) sidebarKey(k term.Key) bool {
	sb := a.sidebar
	switch {
	case k.Name == "up" || k.Rune == 'k':
		sb.sel = max(0, sb.sel-1)
	case k.Name == "down" || k.Rune == 'j':
		sb.sel = max(0, min(len(sb.devices)-1, sb.sel+1))
	case k.Name == "enter" || k.Rune == ' ':
		a.toggleDevice()
		return true
	case k.Name == "esc" || k.Name == "ctrl+o":
		a.toggleSidebar()
		return true
	case strings.HasPrefix(k.Name, "ctrl+"):
		return false
	default:
		return true
	}
	a.drawChrome()
	return true
}

// sidebarMouse handles clicks and the wheel over the list and reports
// whether it did. Movement and releases pass through, so a drag that started
// on a phone still lifts its finger when it ends over the list.
func (a *app) sidebarMouse(m term.Mouse) bool {
	if a.sidebar == nil || m.Motion || m.Release || int(float64(m.X)/a.size.CellWidth()) < a.panelCol() {
		return false
	}
	sb := a.sidebar
	switch {
	case m.Button == 64:
		sb.sel = max(0, sb.sel-1)
		a.drawChrome()
	case m.Button == 65:
		sb.sel = max(0, min(len(sb.devices)-1, sb.sel+1))
		a.drawChrome()
	case m.Button == 0:
		row := int(float64(m.Y) / a.size.CellHeight())
		if i := sb.offset + (row-listTop)/2; row >= listTop && i < len(sb.devices) {
			sb.sel = i
			a.toggleDevice()
		}
	}
	return true
}

type segment struct{ text, style string }

// drawSidebar draws the list with its left edge at col, clipped to the pane,
// after clearing each row from clearFrom, so it can slide in steps.
func (a *app) drawSidebar(sb *sidebar, col, clearFrom int) {
	s := a.size
	for row := 1; row < s.Rows-footerRows; row++ {
		fmt.Fprintf(a.t, "\x1b[%d;%dH\x1b[0m\x1b[K", row+1, clearFrom+1)
	}
	if sb == nil || col >= s.Cols {
		return
	}
	room := s.Cols - col
	inner := room - 2
	edge := segment{"│ ", sgr(a.pal.frame)}
	line := func(row int, segs ...segment) {
		fmt.Fprintf(a.t, "\x1b[%d;%dH", row+1, col+1)
		left := room
		for _, sg := range segs {
			text := sg.text
			if width(text) > left {
				text = string([]rune(text)[:left])
			}
			a.t.WriteString(sg.style + text)
			left -= width(text)
		}
		a.t.WriteString("\x1b[0m")
	}
	for row := 1; row < s.Rows-footerRows; row++ {
		line(row, edge)
	}
	line(2, edge, segment{"Simulators", sgr(a.pal.text, "1")}, segment{fmt.Sprintf("  %d", len(sb.devices)), sgr(a.pal.dim)})

	visible := max(1, (s.Rows-footerRows-listTop)/2)
	if sb.sel < sb.offset {
		sb.offset = sb.sel
	} else if sb.sel >= sb.offset+visible {
		sb.offset = sb.sel - visible + 1
	}
	for i := sb.offset; i < len(sb.devices) && i < sb.offset+visible; i++ {
		d := sb.devices[i]
		shown := a.phoneFor(d.UDID) != nil
		var bg []string
		if i == sb.sel {
			bg = []string{a.pal.chip}
		}
		style := func(params ...string) string { return sgr(append(bg, params...)...) }
		mark, markStyle := "○ ", style(a.pal.dim)
		switch {
		case shown:
			mark, markStyle = "● ", style(a.pal.accent)
		case d.Booted:
			mark = "● "
		}
		r := listTop + (i-sb.offset)*2
		line(r, edge, segment{mark, markStyle}, segment{fit(d.Name, inner-2), style(a.pal.text, "1")})
		line(r+1, edge, segment{"  ", style()}, segment{fit(d.Runtime, inner-2), style(a.pal.dim)})
	}
}

// fit clips or pads s to exactly n columns.
func fit(s string, n int) string {
	if n <= 0 {
		return ""
	}
	s = clip(s, n)
	return s + strings.Repeat(" ", n-width(s))
}
