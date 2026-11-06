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
		winch:    make(chan os.Signal, 1),
	}
	signal.Notify(a.winch, syscall.SIGWINCH)
	defer signal.Stop(a.winch)
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

type app struct {
	ctx      context.Context
	t        *term.Terminal
	opts     Options
	events   chan any
	ready    chan struct{}
	failures chan streamFailure
	winch    chan os.Signal
	size     term.Size

	pal    palette
	mode   layoutMode
	phones []*phone
	focus  *phone

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
	a.detectTheme()
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
		p.border.Base = 1000 + i*2
	}
	a.focus = a.phones[0]

	if err := a.updateSize(); err != nil {
		return err
	}
	a.t.WriteString("\x1b[0m\x1b[2J")
	a.layout()
	a.drawChrome()
	for _, p := range a.phones {
		p.scale = p.wantScale()
		p.startStream(a.ctx, a.opts.FPS, a.ready, a.failures)
	}

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
		case <-a.winch:
			if a.updateSize() == nil {
				a.relayout()
			}
		case <-tick.C:
			a.fps, a.drawn = a.drawn, 0
			if a.sizeChanged() {
				a.relayout()
			} else {
				a.drawChrome()
			}
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

// sizeChanged rereads the size and reports whether it moved. A new pane can
// settle its pixel size without a SIGWINCH, so the tick checks too.
func (a *app) sizeChanged() bool {
	old := a.size
	return a.updateSize() == nil && a.size != old
}

// message fills the screen with one line of progress, before the phones show.
func (a *app) message(text string) {
	fmt.Fprintf(a.t, "\x1b[0m\x1b[2J\x1b[2;3H%s◆ rexsim%s\x1b[4;3H%s%s\x1b[0m",
		sgr(a.pal.accent, "1"), "\x1b[0m", sgr(a.pal.dim), text)
	_ = a.t.Flush()
}

// fatal shows an error and waits for a key, because Rex closes the pane when
// rexsim exits and the error would vanish with it.
func (a *app) fatal(err error) {
	_ = kitty.ClearAll(a.t)
	fmt.Fprintf(a.t, "\x1b[0m\x1b[2J\x1b[2;3H%s◆ rexsim\x1b[0m\x1b[4;3H%s%s\x1b[6;3H%sPress any key to close.\x1b[0m",
		sgr(a.pal.accent, "1"), sgr(a.pal.err), err, sgr(a.pal.dim))
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
	if r := int(screenRadius(p.aspect()) * float64(f.Width)); r != p.maskR {
		p.mask, p.maskR = cornerMask(r), r
	}
	p.rgba = toRGBA(p.rgba, f.Pix, f.Width, f.Height, f.Stride, p.mask, p.maskR)
	img := kitty.Image{Pix: p.rgba, Format: 32, Width: f.Width, Height: f.Height}
	a.t.WriteString("\x1b[?2026h")
	if err := p.placer.Draw(a.t, img, p.box.col, p.box.row, p.box.cols, p.box.rows, 0); err != nil {
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
		p.border.Forget()
		p.borderKey = ""
	}
	a.t.WriteString("\x1b[0m\x1b[2J")
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

// rowChoices lists the numbers of rows the layout mode allows. Auto tries
// them all and keeps the one that draws the phones biggest: side by side in a
// wide pane, stacked in a tall one.
func (a *app) rowChoices(mode layoutMode) []int {
	n := len(a.phones)
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

// layout places each phone in a rounded frame with its caption below, with
// gaps between them, and centres every row of the grid, so a part-filled last
// row sits in the middle. The terminal scales images to whole cells, so a box
// can be off the phone's aspect ratio by up to a cell; touches map through
// the same box.
func (a *app) layout() {
	for _, p := range a.phones {
		p.frame, p.box = box{}, box{}
	}
	s := a.size
	cw, ch := s.CellWidth(), s.CellHeight()
	availCols, availRows := s.Cols-2*marginCols, s.Rows-4
	n := len(a.phones)

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
		for i, p := range a.phones {
			ar := p.aspect()
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
	pick(a.rowChoices(a.mode))
	if bestR == 0 {
		pick(a.rowChoices(layoutAuto))
	}
	if bestR == 0 {
		return
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
			a.phones[i].frame = cells(x, top, sz.cols+2, sz.rows+2+captionRows)
			a.phones[i].box = cells(x+1, top+1, sz.cols, sz.rows)
			x += sz.cols + 2 + gapCols
		}
		y += height + gapRows
	}
}

func (a *app) drawChrome() {
	s := a.size
	if s.Rows < 4 || s.Cols < 20 || a.focus == nil {
		return
	}
	w := a.t
	w.WriteString("\x1b[?2026h")
	a.drawHeader()
	for _, p := range a.phones {
		a.drawFrame(p)
	}
	a.drawFooter()
	w.WriteString("\x1b[0m\x1b[?2026l")
	_ = w.Flush()
}

func width(s string) int { return utf8.RuneCountInString(s) }

func (a *app) drawHeader() {
	fmt.Fprintf(a.t, "\x1b[1;1H\x1b[0m\x1b[2K %s◆ rexsim", sgr(a.pal.accent, "1"))
	if n := len(a.phones); n > 1 {
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
	focused := p == a.focus && len(a.phones) > 1
	a.drawBorder(p, focused)

	bottom := f.row + f.rows - 1 - captionRows
	room := f.cols + gapCols - 1
	var name, detail, nameStyle string
	if p.failed != "" {
		name, detail, nameStyle = p.device.Name, "  "+p.failed, sgr(a.pal.err, "1")
	} else {
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
		hints := [][2]string{{"⌃B", "home"}, {"⌃L", "lock"}, {"⌃S", "screenshot"}, {"⌃G", "layout"}, {"⌃]", "quit"}}
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

func (a *app) cycleLayout() {
	a.mode = (a.mode + 1) % 4
	a.relayout()
	a.flash("Layout: " + a.mode.String())
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
		a.sendScreenshot(a.focus)
	case "ctrl+g":
		a.cycleLayout()
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

// sendScreenshot saves a full-resolution screenshot of a phone and types its
// path into the agent's pane, so the agent can look at the screen. Without an
// agent, it copies the path.
func (a *app) sendScreenshot(p *phone) {
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
