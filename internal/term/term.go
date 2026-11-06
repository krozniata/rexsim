// Package term puts the terminal in raw mode and reads keys, mouse events
// and pastes from it.
package term

import (
	"bufio"
	"os"

	"golang.org/x/sys/unix"
	xterm "golang.org/x/term"
)

type Terminal struct {
	*bufio.Writer
	fd  int
	old *xterm.State
}

func Open() (*Terminal, error) {
	fd := int(os.Stdin.Fd())
	old, err := xterm.MakeRaw(fd)
	if err != nil {
		return nil, err
	}
	t := &Terminal{Writer: bufio.NewWriterSize(os.Stdout, 1<<16), fd: fd, old: old}
	t.WriteString("\x1b[?1049h\x1b[?25l\x1b[2J")
	return t, t.Flush()
}

// EnableInput turns on mouse reporting in pixels (1016) rather than cells, so
// a click maps to an exact point on the phone, and bracketed paste.
func (t *Terminal) EnableInput() error {
	t.WriteString("\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1016h\x1b[?2004h")
	return t.Flush()
}

func (t *Terminal) Close() {
	t.WriteString("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?2004l\x1b[?1016l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l")
	_ = t.Flush()
	_ = xterm.Restore(t.fd, t.old)
}

// Size is the terminal's size in cells and in pixels.
type Size struct {
	Cols, Rows    int
	Width, Height int
}

func (s Size) CellWidth() float64 {
	if s.Width == 0 {
		return 8
	}
	return float64(s.Width) / float64(s.Cols)
}

func (s Size) CellHeight() float64 {
	if s.Height == 0 {
		return 16
	}
	return float64(s.Height) / float64(s.Rows)
}

func (t *Terminal) Size() (Size, error) {
	ws, err := unix.IoctlGetWinsize(t.fd, unix.TIOCGWINSZ)
	if err != nil {
		return Size{}, err
	}
	return Size{Cols: int(ws.Col), Rows: int(ws.Row), Width: int(ws.Xpixel), Height: int(ws.Ypixel)}, nil
}
