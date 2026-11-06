package view

import (
	"time"

	"rexsim/internal/idb"
	"rexsim/internal/term"
)

const (
	moveInterval = 12 * time.Millisecond
	wheelWindow  = 100 * time.Millisecond
	wheelStep    = 30.0
)

func (a *app) handle(ev any) error {
	switch ev := ev.(type) {
	case term.Key:
		return a.key(ev)
	case term.Paste:
		if a.sidebar == nil && a.usable(a.focus) {
			a.report(a.focus.idb.Text(ev.Text))
		}
	case term.Mouse:
		return a.mouse(ev)
	}
	return nil
}

var namedKeys = map[string]uint64{
	"enter": idb.KeyEnter, "backspace": idb.KeyBackspace, "tab": idb.KeyTab, "esc": idb.KeyEscape,
	"up": idb.KeyUp, "down": idb.KeyDown, "left": idb.KeyLeft, "right": idb.KeyRight,
}

// key sends typing to the phone clicked last.
func (a *app) key(k term.Key) error {
	if a.sidebar != nil && a.sidebarKey(k) {
		return nil
	}
	switch k.Name {
	case "ctrl+]", "ctrl+c", "ctrl+q":
		return errQuit
	case "ctrl+f":
		a.toggleSolo()
	case "ctrl+n":
		a.focusNext()
	case "ctrl+o":
		a.toggleSidebar()
	}
	if !a.usable(a.focus) {
		return nil
	}
	c := a.focus.idb
	switch k.Name {
	case "ctrl+b":
		a.report(c.Button(idb.Home))
	case "ctrl+l":
		a.report(c.Button(idb.Lock))
	case "ctrl+s":
		a.sendScreenshot(a.focus)
	case "":
		a.report(c.Text(string(k.Rune)))
	default:
		if code, ok := namedKeys[k.Name]; ok {
			a.report(c.Key(code, false))
		}
	}
	return nil
}

func (a *app) phoneAt(px, py int) *phone {
	for _, p := range a.phones {
		if p.failed == "" && !p.connecting && p.box.contains(float64(px), float64(py)) {
			return p
		}
	}
	return nil
}

func (a *app) mouse(m term.Mouse) error {
	if a.sidebarMouse(m) {
		return nil
	}
	switch {
	case m.Button >= 64:
		if m.Button > 65 || m.Release || m.Motion {
			return nil
		}
		p := a.phoneAt(m.X, m.Y)
		if p == nil {
			return nil
		}
		if p != a.wheelPhone && a.wheelPhone != nil {
			a.flushWheel()
		}
		a.wheelPhone = p
		if m.Button == 64 {
			a.wheelDY++
		} else {
			a.wheelDY--
		}
		a.wheelX, a.wheelY = p.point(m.X, m.Y)
		if a.wheelC == nil {
			a.wheelC = time.After(wheelWindow)
		}
	case m.Button == 0 && !m.Motion && !m.Release:
		p := a.phoneAt(m.X, m.Y)
		if p == nil {
			for _, q := range a.phones {
				if q.frame.contains(float64(m.X), float64(m.Y)) {
					a.setFocus(q)
				}
			}
			return nil
		}
		a.setFocus(p)
		p.touching = true
		p.lastMove = time.Now()
		x, y := p.point(m.X, m.Y)
		a.report(p.idb.Touch(x, y, true))
	case m.Motion && m.Button == 0:
		for _, p := range a.phones {
			if p.touching && time.Since(p.lastMove) >= moveInterval {
				p.lastMove = time.Now()
				x, y := p.point(m.X, m.Y)
				a.report(p.idb.Touch(x, y, true))
			}
		}
	case m.Release:
		for _, p := range a.phones {
			if p.touching {
				p.touching = false
				x, y := p.point(m.X, m.Y)
				a.report(p.idb.Touch(x, y, false))
			}
		}
	}
	return nil
}

// flushWheel turns the wheel ticks of the last moment into one swipe centred
// on the pointer. Sending a swipe per tick would queue up faster than the
// phone plays them.
func (a *app) flushWheel() {
	a.wheelC = nil
	p := a.wheelPhone
	d := min(max(a.wheelDY*wheelStep, -400), 400)
	a.wheelDY = 0
	if p == nil || d == 0 {
		return
	}
	h := p.screen.HeightPoints
	y0 := min(max(a.wheelY-d/2, 1), h-1)
	y1 := min(max(a.wheelY+d/2, 1), h-1)
	a.report(p.idb.Swipe(a.wheelX, y0, a.wheelX, y1, 0.08))
}
