package term

import (
	"bytes"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Key is a typed character in Rune, or a named key such as "enter", "up" or
// "ctrl+b" in Name.
type Key struct {
	Rune rune
	Name string
}

// Mouse is an SGR mouse report. X and Y are zero-based pixels while mode 1016
// is on. Button is 0 to 2 for the left, middle and right buttons, 3 for none,
// and 64 to 67 for the wheel.
type Mouse struct {
	Button  int
	X, Y    int
	Release bool
	Motion  bool
}

type Paste struct{ Text string }

// OSC is a reply to an operating system command query, such as "11;rgb:…"
// for the background colour.
type OSC struct{ Text string }

// parseOSC reads an OSC reply, which ends with BEL or ST.
func parseOSC(b []byte) (any, int) {
	for i := 2; i < len(b); i++ {
		switch {
		case b[i] == 0x07:
			return OSC{Text: string(b[2:i])}, i + 1
		case b[i] == 0x1b && i+1 < len(b) && b[i+1] == '\\':
			return OSC{Text: string(b[2:i])}, i + 2
		}
	}
	if len(b) > 512 {
		return nil, 1
	}
	return nil, 0
}

const escTimeout = 30 * time.Millisecond

// ReadEvents parses r until it fails and sends each Key, Mouse and Paste to
// out. A lone escape becomes the "esc" key once no more input follows it.
func ReadEvents(r io.Reader, out chan<- any) {
	chunks := make(chan []byte)
	go func() {
		defer close(chunks)
		for {
			buf := make([]byte, 4096)
			n, err := r.Read(buf)
			if n > 0 {
				chunks <- buf[:n]
			}
			if err != nil {
				return
			}
		}
	}()
	var pending []byte
	var timeout <-chan time.Time
	for {
		select {
		case chunk, ok := <-chunks:
			if !ok {
				return
			}
			pending = append(pending, chunk...)
		case <-timeout:
			if len(pending) > 0 && pending[0] == 0x1b {
				out <- Key{Name: "esc"}
				pending = pending[1:]
			}
		}
		timeout = nil
		for len(pending) > 0 {
			ev, n := parse(pending)
			if n == 0 {
				timeout = time.After(escTimeout)
				break
			}
			pending = pending[n:]
			if ev != nil {
				out <- ev
			}
		}
	}
}

// parse reads one event from the front of b. It returns n == 0 when b holds
// only the start of an event.
func parse(b []byte) (ev any, n int) {
	switch c := b[0]; {
	case c == 0x1b:
		return parseEscape(b)
	case c == '\r' || c == '\n':
		return Key{Name: "enter"}, 1
	case c == '\t':
		return Key{Name: "tab"}, 1
	case c == 0x7f || c == 0x08:
		return Key{Name: "backspace"}, 1
	case c == 0x1d:
		return Key{Name: "ctrl+]"}, 1
	case c >= 1 && c <= 26:
		return Key{Name: "ctrl+" + string(rune('a'+c-1))}, 1
	case c < 0x20:
		return nil, 1
	}
	if !utf8.FullRune(b) {
		return nil, 0
	}
	r, size := utf8.DecodeRune(b)
	if r == utf8.RuneError {
		return nil, size
	}
	return Key{Rune: r}, size
}

func parseEscape(b []byte) (any, int) {
	if len(b) < 2 {
		return nil, 0
	}
	switch b[1] {
	case 'O':
		if len(b) < 3 {
			return nil, 0
		}
		return arrow(b[2]), 3
	case ']':
		return parseOSC(b)
	case '[':
	default:
		return Key{Name: "esc"}, 1
	}
	end := -1
	for i := 2; i < len(b); i++ {
		if b[i] >= 0x40 && b[i] <= 0x7e {
			end = i
			break
		}
	}
	if end < 0 {
		if len(b) > 64 {
			return nil, 1
		}
		return nil, 0
	}
	params, final := string(b[2:end]), b[end]
	switch {
	case strings.HasPrefix(params, "<") && (final == 'M' || final == 'm'):
		return parseMouse(params[1:], final == 'm'), end + 1
	case params == "200" && final == '~':
		const stop = "\x1b[201~"
		i := bytes.Index(b[end+1:], []byte(stop))
		if i < 0 {
			return nil, 0
		}
		return Paste{Text: string(b[end+1 : end+1+i])}, end + 1 + i + len(stop)
	case final >= 'A' && final <= 'D':
		return arrow(final), end + 1
	}
	return nil, end + 1
}

func arrow(c byte) any {
	switch c {
	case 'A':
		return Key{Name: "up"}
	case 'B':
		return Key{Name: "down"}
	case 'C':
		return Key{Name: "right"}
	case 'D':
		return Key{Name: "left"}
	}
	return nil
}

func parseMouse(params string, release bool) any {
	parts := strings.Split(params, ";")
	if len(parts) != 3 {
		return nil
	}
	var v [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		v[i] = n
	}
	return Mouse{
		Button:  v[0] &^ (4 | 8 | 16 | 32),
		X:       v[1] - 1,
		Y:       v[2] - 1,
		Release: release,
		Motion:  v[0]&32 != 0,
	}
}
