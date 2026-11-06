package view

import (
	"math"
	"strconv"
	"strings"
)

// screenRadius is a phone's screen corner radius as a fraction of its width.
// The framebuffer is square, so rexsim rounds it the way the hardware is.
// iPhones are about 55 points on 402; iPads about 18 on 820.
func screenRadius(aspect float64) float64 {
	if aspect < 0.6 {
		return 0.137
	}
	return 0.022
}

// cornerMask holds the anti-aliased coverage of a top-left corner of radius
// r, row by row.
func cornerMask(r int) []uint8 {
	m := make([]uint8, r*r)
	for y := 0; y < r; y++ {
		for x := 0; x < r; x++ {
			d := math.Hypot(float64(r)-(float64(x)+0.5), float64(r)-(float64(y)+0.5))
			m[y*r+x] = uint8(min(max(float64(r)-d+0.5, 0), 1) * 255)
		}
	}
	return m
}

// toRGBA converts BGRA pixels, whose rows are stride bytes apart, to tightly
// packed RGBA, and makes the corners outside the screen's radius transparent.
func toRGBA(dst, bgra []byte, width, height, stride int, mask []uint8, r int) []byte {
	n := width * height * 4
	if cap(dst) < n {
		dst = make([]byte, n)
	}
	dst = dst[:n]
	i := 0
	for y := 0; y < height; y++ {
		row := bgra[y*stride : y*stride+width*4]
		for x := 0; x < len(row); x += 4 {
			dst[i], dst[i+1], dst[i+2], dst[i+3] = row[x+2], row[x+1], row[x], 255
			i += 4
		}
	}
	maskWidth := r
	r = min(r, width/2, height/2)
	for y := 0; y < r; y++ {
		for x := 0; x < r; x++ {
			a := mask[y*maskWidth+x]
			for _, p := range [][2]int{{x, y}, {width - 1 - x, y}, {x, height - 1 - y}, {width - 1 - x, height - 1 - y}} {
				dst[(p[1]*width+p[0])*4+3] = a
			}
		}
	}
	return dst
}

// roundedOutline draws an anti-aliased rounded rectangle outline in an RGBA
// image of w by h pixels. The rectangle's edges are at left, top, right and
// bottom, with corner radius r and line width stroke.
func roundedOutline(w, h int, left, top, right, bottom, r, stroke float64, color [3]byte) []byte {
	img := make([]byte, w*h*4)
	cx, cy := (left+right)/2, (top+bottom)/2
	hx, hy := (right-left)/2-r, (bottom-top)/2-r
	reach := stroke/2 + 1
	plot := func(x, y int) {
		qx := math.Abs(float64(x)+0.5-cx) - hx
		qy := math.Abs(float64(y)+0.5-cy) - hy
		sd := math.Hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
		a := min(max(stroke/2+0.5-math.Abs(sd), 0), 1)
		if a > 0 {
			i := (y*w + x) * 4
			img[i], img[i+1], img[i+2], img[i+3] = color[0], color[1], color[2], uint8(a*255)
		}
	}
	band := func(lo, hi float64, n int) (int, int) {
		return max(0, int(lo-reach)), min(n, int(math.Ceil(hi+reach)))
	}
	for y := 0; y < h; y++ {
		fy := float64(y) + 0.5
		if fy < top+r+reach || fy > bottom-r-reach {
			x0, x1 := band(left, right, w)
			for x := x0; x < x1; x++ {
				plot(x, y)
			}
			continue
		}
		for _, edge := range []float64{left, right} {
			x0, x1 := band(edge, edge, w)
			for x := x0; x < x1; x++ {
				plot(x, y)
			}
		}
	}
	return img
}

// rgbOf reads the colour out of SGR parameters such as "38;2;10;132;255".
func rgbOf(params string) [3]byte {
	parts := strings.Split(params, ";")
	var c [3]byte
	if len(parts) == 5 {
		for i := range c {
			v, _ := strconv.Atoi(parts[2+i])
			c[i] = byte(v)
		}
	}
	return c
}
