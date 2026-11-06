package view

import (
	"errors"
	"fmt"
	"strings"

	"rexsim/internal/sim"
	"rexsim/internal/term"
)

func (a *app) chooseDevices() ([]sim.Device, error) {
	devices, err := sim.Devices(a.ctx)
	if err != nil {
		return nil, err
	}
	if len(a.opts.UDIDs) > 0 {
		var chosen []sim.Device
		for _, udid := range a.opts.UDIDs {
			found := false
			for _, d := range devices {
				if d.UDID == udid {
					chosen = append(chosen, d)
					found = true
					break
				}
			}
			if !found {
				return nil, fmt.Errorf("no available simulator has UDID %s", udid)
			}
		}
		return chosen, nil
	}
	if len(devices) == 0 {
		return nil, errors.New("no iOS simulators are available; add one in Xcode")
	}
	booted := 0
	for _, d := range devices {
		if d.Booted {
			booted++
		}
	}
	if booted == 1 {
		return devices[:1], nil
	}
	return a.pick(devices, "choose simulators")
}

// pick lists the simulators with the booted ones first and marked, so Enter
// shows all of them. Space marks or unmarks one; a digit or a click shows
// only that one.
func (a *app) pick(devices []sim.Device, title string) ([]sim.Device, error) {
	const top = 5
	marked := make([]bool, len(devices))
	for i, d := range devices {
		marked[i] = d.Booted
	}
	labelWidth := 0
	for _, d := range devices {
		labelWidth = max(labelWidth, width(d.Label()))
	}
	sel, offset := 0, 0
	for {
		visible := max(1, a.size.Rows-top-1)
		if sel < offset {
			offset = sel
		} else if sel >= offset+visible {
			offset = sel - visible + 1
		}
		fmt.Fprintf(a.t, "\x1b[0m\x1b[2J\x1b[2;3H%s◆ rexsim%s  %s", sgr(a.pal.accent, "1"), sgr(a.pal.dim), title)
		fmt.Fprintf(a.t, "\x1b[3;3H%s↑↓ move   space select   enter open   1–9 open one   q quit\x1b[0m", sgr(a.pal.dim))
		for i := offset; i < len(devices) && i < offset+visible; i++ {
			d := devices[i]
			mark, markStyle := "○", sgr(a.pal.dim)
			if marked[i] {
				mark, markStyle = "●", sgr(a.pal.accent)
			}
			tag := ""
			if d.Booted {
				tag = "booted"
			}
			label := d.Label() + strings.Repeat(" ", labelWidth-width(d.Label()))
			bg, text := "", sgr(a.pal.text)
			if i == sel {
				bg = a.pal.chip
				text = sgr(bg, a.pal.chipText, "1")
				markStyle = strings.Replace(markStyle, "\x1b[0;", "\x1b[0;"+bg+";", 1)
			}
			tagStyle := sgr(a.pal.dim)
			if bg != "" {
				tagStyle = sgr(bg, a.pal.dim)
			}
			fmt.Fprintf(a.t, "\x1b[%d;3H%s %s %s %s  %s%-6s \x1b[0m", top+i-offset, markStyle, mark, text, label, tagStyle, tag)
		}
		_ = a.t.Flush()

		var ev any
		select {
		case <-a.ctx.Done():
			return nil, a.ctx.Err()
		case <-a.winch:
			_ = a.updateSize()
			continue
		case ev = <-a.events:
		}
		switch ev := ev.(type) {
		case term.Key:
			switch {
			case ev.Name == "up" || ev.Rune == 'k':
				sel = max(0, sel-1)
			case ev.Name == "down" || ev.Rune == 'j':
				sel = min(len(devices)-1, sel+1)
			case ev.Rune == ' ':
				marked[sel] = !marked[sel]
			case ev.Name == "enter":
				var chosen []sim.Device
				for i, d := range devices {
					if marked[i] {
						chosen = append(chosen, d)
					}
				}
				if len(chosen) == 0 {
					chosen = devices[sel : sel+1]
				}
				return chosen, nil
			case ev.Rune >= '1' && ev.Rune <= '9' && offset+int(ev.Rune-'1') < len(devices):
				i := offset + int(ev.Rune-'1')
				return devices[i : i+1], nil
			case ev.Rune == 'q' || ev.Name == "esc" || ev.Name == "ctrl+c" || ev.Name == "ctrl+]":
				return nil, errQuit
			}
		case term.Mouse:
			row := int(float64(ev.Y) / a.size.CellHeight())
			switch {
			case ev.Button == 0 && !ev.Release && !ev.Motion:
				if i := offset + row - (top - 1); row >= top-1 && i < len(devices) {
					return devices[i : i+1], nil
				}
			case ev.Button == 64:
				sel = max(0, sel-1)
			case ev.Button == 65:
				sel = min(len(devices)-1, sel+1)
			}
		}
	}
}
