package view

import (
	"strconv"
	"strings"
	"time"

	"rexsim/internal/term"
)

// palette holds SGR parameters, combined by sgr.
type palette struct {
	chip, chipText string
	accent, dim    string
	text, frame    string
	err            string
}

var dark = palette{
	chip: "48;2;50;50;55", chipText: "38;2;235;235;240",
	accent: "38;2;10;132;255", dim: "38;2;142;142;147",
	text: "38;2;235;235;240", frame: "38;2;72;72;78",
	err: "38;2;255;69;58",
}

var light = palette{
	chip: "48;2;222;222;228", chipText: "38;2;28;28;30",
	accent: "38;2;0;122;255", dim: "38;2;142;142;147",
	text: "38;2;28;28;30", frame: "38;2;199;199;204",
	err: "38;2;255;59;48",
}

func sgr(params ...string) string {
	return "\x1b[0;" + strings.Join(params, ";") + "m"
}

const themeTimeout = 300 * time.Millisecond

// detectTheme asks the terminal for its background colour (OSC 11) and
// picks the palette that suits it. A terminal that doesn't answer gets the
// dark one.
func (a *app) detectTheme() {
	a.pal = dark
	a.t.WriteString("\x1b]11;?\x1b\\")
	if a.t.Flush() != nil {
		return
	}
	deadline := time.After(themeTimeout)
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-deadline:
			return
		case ev := <-a.events:
			if osc, ok := ev.(term.OSC); ok && strings.HasPrefix(osc.Text, "11;") {
				if l, ok := luminance(strings.TrimPrefix(osc.Text, "11;")); ok && l > 0.5 {
					a.pal = light
				}
				return
			}
		}
	}
}

// luminance reads a colour such as rgb:1e1e/1e1e/2020, where each channel
// has one to four hex digits.
func luminance(spec string) (float64, bool) {
	rest, ok := strings.CutPrefix(spec, "rgb:")
	if !ok {
		return 0, false
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 3 {
		return 0, false
	}
	var c [3]float64
	for i, p := range parts {
		v, err := strconv.ParseUint(p, 16, 16)
		if err != nil || len(p) == 0 || len(p) > 4 {
			return 0, false
		}
		c[i] = float64(v) / float64(uint64(1)<<(4*len(p))-1)
	}
	return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2], true
}
