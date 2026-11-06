// Package view shows simulators in the terminal and sends the mouse and
// keyboard to them.
package view

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"rexsim/internal/companion"
	"rexsim/internal/kitty"
	"rexsim/internal/sim"
	"rexsim/internal/term"
)

type Options struct {
	UDIDs []string
	Agent string
	FPS   int
}

var errQuit = errors.New("quit")

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
		picked:   make(chan []string, 1),
		dialed:   make(chan connection, 8),
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
	if a.pickLn != nil {
		_ = a.pickLn.Close()
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
	solo   bool
	bin    string
	added  int
	syncs  int
	picked chan []string
	dialed chan connection
	pickLn net.Listener

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
	if a.bin, err = companion.Binary(a.ctx, a.message); err != nil {
		return err
	}
	a.focus = a.add(devices)[0]
	if err := a.updateSize(); err != nil {
		return err
	}
	a.relayout()

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
		case udids := <-a.picked:
			a.addPicked(udids)
		case c := <-a.dialed:
			a.dialDone(c)
		}
	}
}

// add shows a placeholder for each device at once and connects them in the
// background, so the other phones stay usable while a simulator boots. Each
// phone gets image ids no other phone has used, so a closed phone's images
// can't be mistaken for a new one's.
func (a *app) add(devices []sim.Device) []*phone {
	phones := make([]*phone, len(devices))
	for i, d := range devices {
		ctx, cancel := context.WithCancel(a.ctx)
		p := &phone{device: d, connecting: true, cancelConnect: cancel}
		p.placer.Base = a.added * 2
		p.border.Base = 1_000_000 + a.added*2
		a.added++
		phones[i] = p
		go func() { a.dialed <- dial(ctx, a.bin, p, d) }()
	}
	a.phones = append(a.phones, phones...)
	return phones
}

// dialDone fills in a phone once its simulator has booted and its companion
// answers, or shows why it couldn't.
func (a *app) dialDone(c connection) {
	p := c.p
	if !slices.Contains(a.phones, p) {
		c.close()
		return
	}
	p.connecting, p.cancelConnect = false, nil
	if c.err != nil {
		p.failed = c.err.Error()
	} else {
		p.comp, p.idb, p.screen, p.osVersion = c.comp, c.client, c.screen, c.osVersion
	}
	a.relayout()
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

// paint places a phone's frame. A frame shown again, after a relayout, gets
// a new file, because the terminal deleted the first one when it read it.
func (a *app) paint(p *phone, f *frame) {
	p.current = f
	if f.width != p.frameW || f.height != p.frameH {
		p.frameW, p.frameH = f.width, f.height
		a.relayout()
		return
	}
	path := f.path
	f.path = ""
	if p.box.cols == 0 {
		if path != "" {
			_ = os.Remove(path)
		}
		return
	}
	if path == "" {
		var err error
		if path, err = kitty.WriteTemp(f.rgba); err != nil {
			a.flash(err.Error())
			return
		}
	}
	a.beginSync()
	if err := p.placer.Place(a.t, path, 32, f.width, f.height, p.box.col, p.box.row, p.box.cols, p.box.rows, 0); err != nil {
		a.flash(err.Error())
	}
	a.endSync()
	a.drawn++
}

// visible lists the phones on screen: all of them, or only the focused one
// while it fills the pane.
func (a *app) visible() []*phone {
	if a.solo {
		return []*phone{a.focus}
	}
	return a.phones
}

// relayout redraws everything for a new pane size or phone shape. Each image
// replaces its own previous one rather than the screen being cleared first,
// which would flash blank. It restarts the streams whose phones are now drawn
// at another size, and stops those of hidden phones until they show again.
func (a *app) relayout() {
	a.beginSync()
	defer a.endSync()
	for _, p := range a.phones {
		p.borderKey = ""
	}
	a.t.WriteString("\x1b[0m\x1b[2J")
	a.layout()
	a.drawChrome()
	for _, p := range a.phones {
		if p.box.cols == 0 {
			_ = p.placer.Delete(a.t)
			_ = p.border.Delete(a.t)
			p.pauseStream()
			continue
		}
		if s := p.wantScale(); s != p.scale && p.failed == "" && !p.connecting {
			p.scale = s
			p.startStream(a.ctx, a.opts.FPS, a.ready, a.failures)
		}
		if p.current != nil {
			a.paint(p, p.current)
		}
	}
}
