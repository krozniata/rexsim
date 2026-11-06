package view

import (
	"context"
	"hash/crc32"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/krozniata/rexsim/internal/companion"
	"github.com/krozniata/rexsim/internal/idb"
	"github.com/krozniata/rexsim/internal/kitty"
	"github.com/krozniata/rexsim/internal/sim"
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
	latest     *idb.Frame
	lastSum    uint32
	stopStream context.CancelFunc
	scale      float64
	failed     string

	placer         kitty.Placer
	rgba           []byte
	mask           []uint8
	maskR          int
	current        *idb.Frame
	frameW, frameH int
	frame          box
	box            box
	border         kitty.Placer
	borderKey      string

	touching bool
	lastMove time.Time
}

type streamFailure struct {
	p   *phone
	err error
}

func connect(ctx context.Context, bin string, d sim.Device) (*phone, error) {
	if !d.Booted {
		if err := sim.Boot(ctx, d.UDID); err != nil {
			return nil, err
		}
	}
	p := &phone{device: d}
	var err error
	if p.comp, err = companion.Start(ctx, bin, d.UDID); err != nil {
		return nil, err
	}
	if p.idb, err = idb.Dial(ctx, p.comp.Socket); err != nil {
		p.close()
		return nil, err
	}
	if _, p.osVersion, p.screen, err = p.idb.Describe(ctx); err != nil {
		p.close()
		return nil, err
	}
	p.osVersion = strings.TrimSpace(strings.TrimPrefix(p.osVersion, "iOS"))
	return p, nil
}

func (p *phone) label() string { return p.device.Name + " · iOS " + p.osVersion }

func (p *phone) close() {
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
		err := p.idb.Stream(ctx, fps, scale, p.screen, func(f idb.Frame) { p.onFrame(f, ready) })
		if ctx.Err() == nil {
			failures <- streamFailure{p, err}
		}
	}()
}

// onFrame runs on the stream's goroutine. The companion sends frames at a
// steady rate even when nothing changes, so identical ones are dropped, and
// only the newest frame waits while the terminal is busy.
func (p *phone) onFrame(f idb.Frame, ready chan<- struct{}) {
	sum := crc32.Checksum(f.Pix, castagnoli)
	p.mu.Lock()
	if sum == p.lastSum {
		p.mu.Unlock()
		return
	}
	p.lastSum = sum
	p.latest = &f
	p.mu.Unlock()
	select {
	case ready <- struct{}{}:
	default:
	}
}

func (p *phone) takeLatest() *idb.Frame {
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
	if p.frameW > 0 && p.frameH > 0 {
		return float64(p.frameW) / float64(p.frameH)
	}
	return float64(p.screen.Width) / float64(p.screen.Height)
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
