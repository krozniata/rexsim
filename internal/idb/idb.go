// Package idb is a client for the parts of idb_companion's gRPC service that
// rexsim uses: the raw framebuffer stream, HID input and screenshots.
package idb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/krozniata/rexsim/internal/idbpb"
)

type Screen struct {
	Width, Height             int
	WidthPoints, HeightPoints float64
}

type Client struct {
	conn *grpc.ClientConn
	svc  pb.CompanionServiceClient

	ctx context.Context
	mu  sync.Mutex
	hid grpc.ClientStreamingClient[pb.HIDEvent, pb.HIDResponse]
}

func Dial(ctx context.Context, socket string) (*Client, error) {
	conn, err := grpc.NewClient("unix://"+socket,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(256<<20)))
	if err != nil {
		return nil, err
	}
	return &Client{conn: conn, svc: pb.NewCompanionServiceClient(conn), ctx: ctx}, nil
}

func (c *Client) Close() {
	c.mu.Lock()
	if c.hid != nil {
		_, _ = c.hid.CloseAndRecv()
		c.hid = nil
	}
	c.mu.Unlock()
	_ = c.conn.Close()
}

func (c *Client) Describe(ctx context.Context) (name, osVersion string, s Screen, err error) {
	res, err := c.svc.Describe(ctx, &pb.TargetDescriptionRequest{})
	if err != nil {
		return "", "", Screen{}, err
	}
	d := res.GetTargetDescription()
	dim := d.GetScreenDimensions()
	s = Screen{
		Width:        int(dim.GetWidth()),
		Height:       int(dim.GetHeight()),
		WidthPoints:  float64(dim.GetWidthPoints()),
		HeightPoints: float64(dim.GetHeightPoints()),
	}
	if s.Width == 0 || s.Height == 0 || s.WidthPoints == 0 || s.HeightPoints == 0 {
		return "", "", Screen{}, errors.New("the simulator reported no screen size")
	}
	return d.GetName(), d.GetOsVersion(), s, nil
}

// Frame holds BGRA pixels. Rows are Stride bytes apart, because the
// framebuffer pads each row.
type Frame struct {
	Width, Height, Stride int
	Pix                   []byte
}

// Stream sends raw frames to onFrame until ctx ends or the stream fails.
// The companion sends one frame per message.
func (c *Client) Stream(ctx context.Context, fps int, scale float64, s Screen, onFrame func(Frame)) error {
	stream, err := c.svc.VideoStream(ctx)
	if err != nil {
		return err
	}
	err = stream.Send(&pb.VideoStreamRequest{Control: &pb.VideoStreamRequest_Start_{Start: &pb.VideoStreamRequest_Start{
		Fps:                uint64(fps),
		Format:             pb.VideoStreamRequest_RBGA,
		CompressionQuality: 1,
		ScaleFactor:        scale,
	}}})
	if err != nil {
		return err
	}
	for {
		res, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return errors.New("the simulator stopped streaming")
		}
		if err != nil {
			return err
		}
		data := res.GetPayload().GetData()
		if len(data) == 0 {
			continue
		}
		w, h, stride, ok := frameSize(len(data), s, scale)
		if !ok {
			return fmt.Errorf("unexpected frame of %d bytes at scale %.2f", len(data), scale)
		}
		onFrame(Frame{Width: w, Height: h, Stride: stride, Pix: data})
	}
}

// frameSize works out the frame's dimensions from its length. The companion
// doesn't report them and rounds the scaled size its own way. The buffer pads
// each row to an alignment, and can hold a few rows more than the image, as
// at full scale on a 2622-pixel-tall screen, which arrives as 2624 rows.
func frameSize(n int, s Screen, scale float64) (w, h, stride int, ok bool) {
	for _, dims := range [][2]int{{s.Width, s.Height}, {s.Height, s.Width}} {
		for _, w := range around(float64(dims[0]) * scale) {
			for _, align := range []int{64, 16, 32, 128, 256, 4} {
				stride := (w*4 + align - 1) / align * align
				if w <= 0 || n%stride != 0 {
					continue
				}
				rows := n / stride
				for _, h := range around(float64(dims[1]) * scale) {
					if h > 0 && rows >= h && rows-h < 32 {
						return w, h, stride, true
					}
				}
			}
		}
	}
	return 0, 0, 0, false
}

func around(v float64) []int {
	return []int{int(math.Round(v)), int(math.Floor(v)), int(math.Ceil(v))}
}

func (c *Client) send(events ...*pb.HIDEvent) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for attempt := 0; ; attempt++ {
		if c.hid == nil {
			hid, err := c.svc.Hid(c.ctx)
			if err != nil {
				return err
			}
			c.hid = hid
		}
		var err error
		for _, ev := range events {
			if err = c.hid.Send(ev); err != nil {
				break
			}
		}
		if err == nil {
			return nil
		}
		c.hid = nil
		if attempt == 1 {
			return err
		}
	}
}

func direction(down bool) pb.HIDEvent_HIDDirection {
	if down {
		return pb.HIDEvent_DOWN
	}
	return pb.HIDEvent_UP
}

func press(action *pb.HIDEvent_HIDPressAction, down bool) *pb.HIDEvent {
	return &pb.HIDEvent{Event: &pb.HIDEvent_Press{Press: &pb.HIDEvent_HIDPress{Action: action, Direction: direction(down)}}}
}

// Touch puts the finger down at a point, moves it there while it is down, or
// lifts it.
func (c *Client) Touch(x, y float64, down bool) error {
	return c.send(press(&pb.HIDEvent_HIDPressAction{Action: &pb.HIDEvent_HIDPressAction_Touch{
		Touch: &pb.HIDEvent_HIDTouch{Point: &pb.Point{X: x, Y: y}},
	}}, down))
}

type Button = pb.HIDEvent_HIDButtonType

const (
	Home = pb.HIDEvent_HOME
	Lock = pb.HIDEvent_LOCK
)

func (c *Client) Button(b Button) error {
	action := &pb.HIDEvent_HIDPressAction{Action: &pb.HIDEvent_HIDPressAction_Button{Button: &pb.HIDEvent_HIDButton{Button: b}}}
	return c.send(press(action, true), press(action, false))
}

func keyAction(code uint64) *pb.HIDEvent_HIDPressAction {
	return &pb.HIDEvent_HIDPressAction{Action: &pb.HIDEvent_HIDPressAction_Key{Key: &pb.HIDEvent_HIDKey{Keycode: code}}}
}

// Key taps a key by its USB HID usage, holding shift if asked.
func (c *Client) Key(code uint64, shift bool) error {
	var events []*pb.HIDEvent
	if shift {
		events = append(events, press(keyAction(KeyLeftShift), true))
	}
	events = append(events, press(keyAction(code), true), press(keyAction(code), false))
	if shift {
		events = append(events, press(keyAction(KeyLeftShift), false))
	}
	return c.send(events...)
}

// Text types the characters that a US keyboard has, and skips the others.
func (c *Client) Text(s string) error {
	for _, r := range s {
		if code, shift, ok := KeyFor(r); ok {
			if err := c.Key(code, shift); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *Client) Swipe(x0, y0, x1, y1, seconds float64) error {
	return c.send(&pb.HIDEvent{Event: &pb.HIDEvent_Swipe{Swipe: &pb.HIDEvent_HIDSwipe{
		Start:    &pb.Point{X: x0, Y: y0},
		End:      &pb.Point{X: x1, Y: y1},
		Duration: seconds,
	}}})
}

func (c *Client) Screenshot(ctx context.Context) ([]byte, error) {
	res, err := c.svc.Screenshot(ctx, &pb.ScreenshotRequest{Format: pb.ScreenshotRequest_PNG})
	if err != nil {
		return nil, err
	}
	return res.GetImageData(), nil
}
