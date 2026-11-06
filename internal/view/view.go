// Package view shows simulators in the terminal and sends the mouse and
// keyboard to them.
package view

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/krozniata/rexsim/internal/companion"
	"github.com/krozniata/rexsim/internal/idb"
	"github.com/krozniata/rexsim/internal/kitty"
	"github.com/krozniata/rexsim/internal/sim"
	"github.com/krozniata/rexsim/internal/term"
)

type Options struct {
	UDIDs []string
	Agent string
	FPS   int
}

var errQuit = errors.New("quit")

const (
	moveInterval = 12 * time.Millisecond
	wheelWindow  = 100 * time.Millisecond
	wheelStep    = 30.0
	statusTime   = 4 * time.Second
)

func Run(ctx context.Context, opts Options) error {
	t, err := term.Open()
	if err != nil {
		return err
	}
	a := &app{
		ctx:      ctx,
		t:        t,
		opts:     opts,
		events:   make(chan any, 64),
		ready:    make(chan struct{}, 1),
		failures: make(chan streamFailure, 8),
	}
	go term.ReadEvents(os.Stdin, a.events)
	err = a.run()
	if err != nil && !errors.Is(err, errQuit) && ctx.Err() == nil {
		a.fatal(err)
	}
	for _, p := range a.phones {
		p.close()
	}
	t.Close()
	if errors.Is(err, errQuit) || ctx.Err() != nil {
		return nil
	}
	return err
}

type button struct {
	col0, col1 int
	do         func()
}

type app struct {
	ctx      context.Context
	t        *term.Terminal
	opts     Options
	events   chan any
	ready    chan struct{}
	failures chan streamFailure
	size     term.Size

	phones  []*phone
	focus   *phone
	buttons []button

	wheelPhone *phone
	wheelDY    float64
	wheelX     float64
	wheelY     float64
	wheelC     <-chan time.Time

	status      string
	statusUntil time.Time
	drawn, fps  int
}

func (a *app) run() error {
	if err := a.updateSize(); err != nil {
		return err
	}
	if err := a.t.EnableInput(); err != nil {
		return err
	}
	a.message("Looking for simulators…")
	devices, err := a.chooseDevices()
	if err != nil {
		return err
	}
	bin, err := companion.Binary(a.ctx, a.message)
	if err != nil {
		return err
	}
	if len(devices) == 1 {
		a.message("Connecting to " + devices[0].Label() + "…")
	} else {
		a.message(fmt.Sprintf("Connecting to %d simulators…", len(devices)))
	}
	if a.phones, err = connectAll(a.ctx, bin, devices); err != nil {
		return err
	}
	for i, p := range a.phones {
		p.placer.Base = i * 2
	}
	a.focus = a.phones[0]

	a.t.WriteString("\x1b[2J")
	a.layout()
	a.drawChrome()
	for _, p := range a.phones {
		p.scale = p.wantScale()
		p.startStream(a.ctx, a.opts.FPS, a.ready, a.failures)
	}

	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	defer signal.Stop(winch)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return nil
		case f := <-a.failures:
			if err := a.streamFailed(f); err != nil {
				return err
			}
		case <-a.ready:
			for _, p := range a.phones {
				if f := p.takeLatest(); f != nil {
					a.paint(p, f)
				}
			}
		case ev := <-a.events:
			if err := a.handle(ev); err != nil {
				return err
			}
		case <-winch:
			if a.updateSize() == nil {
				a.relayout()
			}
		case <-tick.C:
			a.fps, a.drawn = a.drawn, 0
			a.drawChrome()
		case <-a.wheelC:
			a.flushWheel()
		}
	}
}

// connectAll starts a companion for each device at once, because each one
// takes a second or more to come up.
func connectAll(ctx context.Context, bin string, devices []sim.Device) ([]*phone, error) {
	phones := make([]*phone, len(devices))
	errs := make([]error, len(devices))
	var wg sync.WaitGroup
	for i, d := range devices {
		wg.Go(func() { phones[i], errs[i] = connect(ctx, bin, d) })
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		for _, p := range phones {
			if p != nil {
				p.close()
			}
		}
		return nil, err
	}
	return phones, nil
}

// streamFailed keeps the other phones running when one stops, for example
// because its simulator shut down.
func (a *app) streamFailed(f streamFailure) error {
	f.p.failed = f.err.Error()
	for _, p := range a.phones {
		if p.failed == "" {
			a.flash(f.p.device.Name + ": " + f.p.failed)
			return nil
		}
	}
	return f.err
}

func (a *app) updateSize() error {
	s, err := a.t.Size()
	if err != nil {
		return err
	}
	a.size = s
	return nil
}

// message fills the screen with one line of progress, before the phones show.
func (a *app) message(text string) {
	fmt.Fprintf(a.t, "\x1b[2J\x1b[2;3H%s", text)
	_ = a.t.Flush()
}

// fatal shows an error and waits for a key, because Rex closes the pane when
// rexsim exits and the error would vanish with it.
func (a *app) fatal(err error) {
	_ = kitty.ClearAll(a.t)
	fmt.Fprintf(a.t, "\x1b[2J\x1b[2;3H\x1b[1mrexsim:\x1b[0m %s\x1b[4;3H\x1b[2mPress any key to close.\x1b[0m", err)
	_ = a.t.Flush()
	for {
		select {
		case <-a.ctx.Done():
			return
		case ev := <-a.events:
			if _, ok := ev.(term.Key); ok {
				return
			}
		}
	}
}

func (a *app) paint(p *phone, f *idb.Frame) {
	p.current = f
	if f.Width != p.frameW || f.Height != p.frameH {
		p.frameW, p.frameH = f.Width, f.Height
		a.relayout()
		return
	}
	if p.box.cols == 0 {
		return
	}
	p.rgb = toRGB(p.rgb, f)
	a.t.WriteString("\x1b[?2026h")
	if err := p.placer.Draw(a.t, p.rgb, f.Width, f.Height, p.box.col, p.box.row, p.box.cols, p.box.rows); err != nil {
		a.flash(err.Error())
	}
	a.t.WriteString("\x1b[?2026l")
	_ = a.t.Flush()
	a.drawn++
}

// relayout redraws everything for a new pane size or phone shape, and
// restarts the streams whose phones are now drawn at another size.
func (a *app) relayout() {
	_ = kitty.ClearAll(a.t)
	for _, p := range a.phones {
		p.placer.Forget()
	}
	a.t.WriteString("\x1b[2J")
	a.layout()
	a.drawChrome()
	for _, p := range a.phones {
		if s := p.wantScale(); s != p.scale && p.failed == "" {
			p.scale = s
			p.startStream(a.ctx, a.opts.FPS, a.ready, a.failures)
		}
		if p.current != nil {
			a.paint(p, p.current)
		}
	}
}

// layout tries each grid of rows and columns and keeps the one that draws
// the phones biggest: side by side in a wide pane, stacked in a tall one.
// The terminal scales images to whole cells, so a box can be off the phone's
// aspect ratio by up to a cell; touches map through the same box.
func (a *app) layout() {
	s := a.size
	cw, ch := s.CellWidth(), s.CellHeight()
	availCols, availRows := s.Cols, s.Rows-2
	n := len(a.phones)
	labelRows := 0
	if n > 1 {
		labelRows = 1
	}
	bestK, bestR := 0.0, 0
	for r := 1; r <= n; r++ {
		c := (n + r - 1) / r
		slotCols, slotRows := availCols/c, availRows/r-labelRows
		if slotCols < 1 || slotRows < 1 {
			continue
		}
		k := math.Inf(1)
		for _, p := range a.phones {
			fw, fh := p.size()
			k = min(k, float64(slotCols)*cw/fw, float64(slotRows)*ch/fh)
		}
		if k > bestK {
			bestK, bestR = k, r
		}
	}
	for _, p := range a.phones {
		p.slot, p.box = box{}, box{}
	}
	if bestR == 0 {
		return
	}
	c := (n + bestR - 1) / bestR
	slotCols, slotRows := availCols/c, availRows/bestR
	left := (availCols - slotCols*c) / 2
	cells := func(col, row, cols, rows int) box {
		return box{col: col, row: row, cols: cols, rows: rows,
			x: float64(col) * cw, y: float64(row) * ch, w: float64(cols) * cw, h: float64(rows) * ch}
	}
	for i, p := range a.phones {
		sc, sr := left+(i%c)*slotCols, 1+(i/c)*slotRows
		p.slot = cells(sc, sr, slotCols, slotRows)
		inner := slotRows - labelRows
		fw, fh := p.size()
		k := min(float64(slotCols)*cw/fw, float64(inner)*ch/fh)
		cols := min(slotCols, max(1, int(math.Round(fw*k/cw))))
		rows := min(inner, max(1, int(math.Round(fh*k/ch))))
		p.box = cells(sc+(slotCols-cols)/2, sr+labelRows+(inner-rows)/2, cols, rows)
	}
}

func (a *app) drawChrome() {
	s := a.size
	if s.Rows < 2 || s.Cols < 10 || a.focus == nil {
		return
	}
	labels := []struct {
		text string
		do   func()
	}{
		{" Home ", func() { a.report(a.focus.idb.Button(idb.Home)) }},
		{" Lock ", func() { a.report(a.focus.idb.Button(idb.Lock)) }},
		{" Send ", a.sendScreenshot},
		{" ✕ ", nil},
	}
	width := 0
	for _, l := range labels {
		width += utf8.RuneCountInString(l.text) + 1
	}
	w := a.t
	w.WriteString("\x1b[?2026h")
	title := " " + a.focus.label()
	if len(a.phones) > 1 {
		title = " ▸ " + a.focus.label()
	}
	fmt.Fprintf(w, "\x1b[1;1H\x1b[2K\x1b[1m%s\x1b[0m", clip(title, s.Cols-width-1))
	a.buttons = a.buttons[:0]
	col := max(0, s.Cols-width)
	for _, l := range labels {
		n := utf8.RuneCountInString(l.text)
		fmt.Fprintf(w, "\x1b[1;%dH\x1b[7m%s\x1b[0m", col+1, l.text)
		a.buttons = append(a.buttons, button{col0: col, col1: col + n, do: l.do})
		col += n + 1
	}

	if len(a.phones) > 1 {
		for _, p := range a.phones {
			if p.box.cols == 0 {
				continue
			}
			text, style := p.label(), "\x1b[2m"
			if p.failed != "" {
				text, style = p.device.Name+": "+p.failed, "\x1b[31m"
			} else if p == a.focus {
				style = "\x1b[1m"
			}
			text = clip(text, p.slot.cols)
			start := p.box.col + (p.box.cols-utf8.RuneCountInString(text))/2
			start = min(max(start, p.slot.col), p.slot.col+p.slot.cols-utf8.RuneCountInString(text))
			fmt.Fprintf(w, "\x1b[%d;%dH\x1b[0K%s%s\x1b[0m", p.box.row, start+1, style, text)
		}
	}

	foot := "drag to swipe · wheel scrolls · type to type · ^B home ^L lock ^S send ^] quit"
	if time.Now().Before(a.statusUntil) {
		foot = a.status
	}
	rate := "idle "
	if a.fps > 0 {
		rate = fmt.Sprintf("%d fps ", a.fps)
	}
	fmt.Fprintf(w, "\x1b[%d;1H\x1b[2K\x1b[2m %s\x1b[0m", s.Rows, clip(foot, s.Cols-len(rate)-2))
	fmt.Fprintf(w, "\x1b[%d;%dH\x1b[2m%s\x1b[0m", s.Rows, s.Cols-len(rate)+1, rate)
	w.WriteString("\x1b[?2026l")
	_ = w.Flush()
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

func (a *app) setFocus(p *phone) {
	if a.focus != p {
		a.focus = p
		a.drawChrome()
	}
}

func (a *app) handle(ev any) error {
	switch ev := ev.(type) {
	case term.Key:
		return a.key(ev)
	case term.Paste:
		a.report(a.focus.idb.Text(ev.Text))
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
	c := a.focus.idb
	switch k.Name {
	case "ctrl+]", "ctrl+c", "ctrl+q":
		return errQuit
	case "ctrl+b":
		a.report(c.Button(idb.Home))
	case "ctrl+l":
		a.report(c.Button(idb.Lock))
	case "ctrl+s":
		a.sendScreenshot()
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
		if p.failed == "" && p.box.contains(float64(px), float64(py)) {
			return p
		}
	}
	return nil
}

func (a *app) mouse(m term.Mouse) error {
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
		if row := int(float64(m.Y) / a.size.CellHeight()); row == 0 {
			return a.click(int(float64(m.X) / a.size.CellWidth()))
		}
		p := a.phoneAt(m.X, m.Y)
		if p == nil {
			for _, q := range a.phones {
				if q.slot.contains(float64(m.X), float64(m.Y)) {
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

func (a *app) click(col int) error {
	for _, b := range a.buttons {
		if col >= b.col0 && col < b.col1 {
			if b.do == nil {
				return errQuit
			}
			b.do()
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

// sendScreenshot saves a full-resolution screenshot of the focused phone and
// types its path into the agent's pane, so the agent can look at the screen.
// Without an agent, it copies the path.
func (a *app) sendScreenshot() {
	p := a.focus
	png, err := p.idb.Screenshot(a.ctx)
	if err != nil {
		a.flash(err.Error())
		return
	}
	dir := filepath.Join(os.TempDir(), "rexsim")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		a.flash(err.Error())
		return
	}
	name := strings.Map(func(r rune) rune {
		if r == ' ' || r == '/' {
			return '-'
		}
		return r
	}, p.device.Name)
	path := filepath.Join(dir, name+"-"+time.Now().Format("150405")+".png")
	if err := os.WriteFile(path, png, 0o600); err != nil {
		a.flash(err.Error())
		return
	}
	if session := os.Getenv("REX_SESSION"); a.opts.Agent != "" && session != "" {
		if err := exec.Command("rex", "send", "-s", session, "-b", a.opts.Agent, path+" ").Run(); err == nil {
			a.flash("Sent a screenshot of " + p.device.Name + " to the agent's input")
			return
		}
	}
	cmd := exec.Command("pbcopy")
	cmd.Stdin = strings.NewReader(path)
	if err := cmd.Run(); err != nil {
		a.flash("Saved " + path)
		return
	}
	a.flash("Copied the screenshot's path: " + path)
}
