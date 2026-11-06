package view

import (
	"context"
	"hash/crc32"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"rexsim/internal/companion"
	"rexsim/internal/idb"
	"rexsim/internal/kitty"
	"rexsim/internal/sim"
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

type box struct {
	col, row, cols, rows int
	x, y, w, h           float64
}

func (b box) contains(px, py float64) bool {
	return px >= b.x && px < b.x+b.w && py >= b.y && py < b.y+b.h
}

// phone is one simulator in the pane, with its own companion and stream.
type phone struct {
	device    sim.Device
	osVersion string
	comp      *companion.Companion
	idb       *idb.Client
	screen    idb.Screen

	mu         sync.Mutex
	latest     *frame
	lastSum    uint32
	stopStream context.CancelFunc
	scale      float64
	failed     string

	connecting    bool
	cancelConnect context.CancelFunc

	placer         kitty.Placer
	current        *frame
	frameW, frameH int
	frame          box
	box            box
	border         kitty.Placer
	borderKey      string

	touching bool
	lastMove time.Time
}

// frame is one screen, converted to RGBA with rounded corners. path is the
// temporary file that holds it until it is placed; a repaint writes a new one.
type frame struct {
	width, height int
	rgba          []byte
	path          string
}

type streamFailure struct {
	p   *phone
	err error
}

// connection is the result of dial, handed to the main loop, which owns the
// phone's fields.
type connection struct {
	p         *phone
	comp      *companion.Companion
	client    *idb.Client
	osVersion string
	screen    idb.Screen
	err       error
}

func (c connection) close() {
	if c.client != nil {
		c.client.Close()
	}
	if c.comp != nil {
		c.comp.Close()
	}
}

// dial boots a simulator if needed and connects a companion to it. It runs on
// its own goroutine and doesn't touch the phone.
func dial(ctx context.Context, bin string, p *phone, d sim.Device) connection {
	c := connection{p: p}
	if !d.Booted {
		if c.err = sim.Boot(ctx, d.UDID); c.err != nil {
			return c
		}
	}
	if c.comp, c.err = companion.Start(ctx, bin, d.UDID); c.err != nil {
		return c
	}
	if c.client, c.err = idb.Dial(ctx, c.comp.Socket); c.err != nil {
		c.close()
		return connection{p: p, err: c.err}
	}
	var version string
	if _, version, c.screen, c.err = c.client.Describe(ctx); c.err != nil {
		c.close()
		return connection{p: p, err: c.err}
	}
	c.osVersion = strings.TrimSpace(strings.TrimPrefix(version, "iOS"))
	return c
}

func (p *phone) close() {
	p.mu.Lock()
	if p.latest != nil {
		_ = os.Remove(p.latest.path)
		p.latest = nil
	}
	p.mu.Unlock()
	if p.cancelConnect != nil {
		p.cancelConnect()
	}
	if p.stopStream != nil {
		p.stopStream()
	}
	if p.idb != nil {
		p.idb.Close()
	}
	if p.comp != nil {
		p.comp.Close()
	}
	p.placer.Close()
	p.border.Close()
}

func (p *phone) startStream(ctx context.Context, fps int, ready chan<- struct{}, failures chan<- streamFailure) {
	if p.stopStream != nil {
		p.stopStream()
	}
	ctx, cancel := context.WithCancel(ctx)
	p.stopStream = cancel
	p.mu.Lock()
	p.lastSum = 0
	p.mu.Unlock()
	scale := p.scale
	go func() {
		var corners frameCorners
		err := p.idb.Stream(ctx, fps, scale, p.screen, func(f idb.Frame) { p.onFrame(f, &corners, ready) })
		if ctx.Err() == nil {
			failures <- streamFailure{p, err}
		}
	}()
}

// pauseStream stops the stream of a phone that is hidden. Clearing the scale
// makes relayout start it again once the phone shows.
func (p *phone) pauseStream() {
	if p.stopStream != nil {
		p.stopStream()
		p.stopStream = nil
	}
	p.scale = 0
}

// frameCorners caches the corner mask for one stream's frame size.
type frameCorners struct {
	r    int
	mask []uint8
}

// onFrame runs on the stream's goroutine, so each phone converts its frames
// and writes their files in parallel, and the main loop only places them. The
// companion sends frames at a steady rate even when nothing changes, so
// identical ones are dropped, and only the newest frame waits while the
// terminal is busy; the file of one that is replaced unseen is deleted.
func (p *phone) onFrame(f idb.Frame, corners *frameCorners, ready chan<- struct{}) {
	sum := crc32.Checksum(f.Pix, castagnoli)
	p.mu.Lock()
	same := sum == p.lastSum
	p.lastSum = sum
	p.mu.Unlock()
	if same {
		return
	}
	if r := int(screenRadius(float64(f.Width)/float64(f.Height)) * float64(f.Width)); r != corners.r {
		corners.r, corners.mask = r, cornerMask(r)
	}
	rgba := toRGBA(f.Pix, f.Width, f.Height, f.Stride, corners.mask, corners.r)
	path, err := kitty.WriteTemp(rgba)
	if err != nil {
		return
	}
	p.mu.Lock()
	if p.latest != nil {
		_ = os.Remove(p.latest.path)
	}
	p.latest = &frame{width: f.Width, height: f.Height, rgba: rgba, path: path}
	p.mu.Unlock()
	select {
	case ready <- struct{}{}:
	default:
	}
}

func (p *phone) takeLatest() *frame {
	p.mu.Lock()
	defer p.mu.Unlock()
	f := p.latest
	p.latest = nil
	return f
}

// aspect is the phone's width over its height: the frame's once one arrives,
// since it turns with the phone, and the screen's before that. Layout uses
// only the ratio, because a frame's pixel size depends on the stream's scale,
// which in turn follows the drawn size.
func (p *phone) aspect() float64 {
	switch {
	case p.frameW > 0 && p.frameH > 0:
		return float64(p.frameW) / float64(p.frameH)
	case p.screen.Width > 0 && p.screen.Height > 0:
		return float64(p.screen.Width) / float64(p.screen.Height)
	case strings.Contains(p.device.Name, "iPad"):
		return 0.72
	}
	return 0.46
}

// wantScale streams at the size the phone is drawn, in steps of 5% so small
// resizes keep the stream running.
func (p *phone) wantScale() float64 {
	if p.box.h == 0 {
		return 0.5
	}
	s := math.Ceil(p.box.h/float64(p.screen.Height)*20) / 20
	return min(1, max(0.1, s))
}

// point maps a pixel in the pane to a point on the phone's screen.
func (p *phone) point(px, py int) (x, y float64) {
	b := p.box
	if b.w == 0 {
		return 0, 0
	}
	fx := min(max((float64(px)-b.x)/b.w, 0), 0.999)
	fy := min(max((float64(py)-b.y)/b.h, 0), 0.999)
	return fx * p.screen.WidthPoints, fy * p.screen.HeightPoints
}
