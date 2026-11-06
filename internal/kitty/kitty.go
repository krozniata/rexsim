// Package kitty draws frames with the kitty graphics protocol.
package kitty

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
)

// Placer sends each frame as a temporary file (t=t) rather than inline base64
// data, so Rex reads the pixels from disk and deletes the file. It alternates
// two image ids, Base+1 and Base+2, and deletes the old one only after the new
// one is placed, so a frame never goes blank in between.
type Placer struct {
	Base    int
	shown   int
	pending []string
}

// Image is raw pixels: 24 for RGB or 32 for RGBA in Format.
type Image struct {
	Pix           []byte
	Format        int
	Width, Height int
}

// WriteTemp writes pixels to a temporary file for Place. The terminal deletes
// the file once it has read it.
func WriteTemp(pix []byte) (string, error) {
	f, err := os.CreateTemp("", "tty-graphics-protocol-rexsim-*.raw")
	if err != nil {
		return "", err
	}
	_, err = f.Write(pix)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// Draw places an image over the cell box at (col, row), scaled to fill cols
// by rows cells. Images with a lower z sit under those with a higher one.
func (p *Placer) Draw(w io.Writer, img Image, col, row, cols, rows, z int) error {
	path, err := WriteTemp(img.Pix)
	if err != nil {
		return err
	}
	return p.Place(w, path, img.Format, img.Width, img.Height, col, row, cols, rows, z)
}

// Place shows an image that WriteTemp wrote, as Draw does.
func (p *Placer) Place(w io.Writer, path string, format, width, height, col, row, cols, rows, z int) error {
	p.track(path)
	id := p.Base + 1
	if p.shown == id {
		id = p.Base + 2
	}
	_, err := fmt.Fprintf(w, "\x1b[%d;%dH\x1b_Ga=T,q=2,f=%d,t=t,s=%d,v=%d,i=%d,p=1,c=%d,r=%d,z=%d,C=1;%s\x1b\\",
		row+1, col+1, format, width, height, id, cols, rows, z, base64.StdEncoding.EncodeToString([]byte(path)))
	if err != nil {
		return err
	}
	if p.shown != 0 {
		_, err = fmt.Fprintf(w, "\x1b_Ga=d,d=I,q=2,i=%d\x1b\\", p.shown)
	}
	p.shown = id
	return err
}

// Shown reports whether an image of this placer is on screen.
func (p *Placer) Shown() bool { return p.shown != 0 }

// Delete removes the image from the screen.
func (p *Placer) Delete(w io.Writer) error {
	if p.shown == 0 {
		return nil
	}
	_, err := fmt.Fprintf(w, "\x1b_Ga=d,d=I,q=2,i=%d\x1b\\", p.shown)
	p.shown = 0
	return err
}

// ClearAll deletes every image in the terminal.
func ClearAll(w io.Writer) error {
	_, err := io.WriteString(w, "\x1b_Ga=d,d=A,q=2\x1b\\")
	return err
}

// track remembers recent files so Close can remove any the terminal didn't
// read, for example because rexsim quit before the terminal caught up.
func (p *Placer) track(name string) {
	p.pending = append(p.pending, name)
	if len(p.pending) > 8 {
		p.pending = p.pending[1:]
	}
}

func (p *Placer) Close() {
	for _, name := range p.pending {
		_ = os.Remove(name)
	}
}
