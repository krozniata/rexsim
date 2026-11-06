package view

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// usable reports whether a phone takes input yet, and says why not.
func (a *app) usable(p *phone) bool {
	switch {
	case p.connecting:
		a.flash(p.device.Name + " is still connecting")
	case p.failed != "":
		a.flash(p.device.Name + ": " + p.failed)
	default:
		return true
	}
	return false
}

// removePhone takes a phone out of the pane and shuts its simulator down.
// The shutdown runs in the background, because it takes a second or two.
func (a *app) removePhone(p *phone) {
	i := slices.Index(a.phones, p)
	a.phones = slices.Delete(a.phones, i, i+1)
	if a.focus == p {
		a.focus = a.phones[min(i, len(a.phones)-1)]
	}
	if len(a.phones) < 2 {
		a.solo = false
	}
	p.close()
	go func() { _ = exec.Command("xcrun", "simctl", "shutdown", p.device.UDID).Run() }()
	a.markShutDown(p.device.UDID)
	a.flash("Shutting down " + p.device.Name)
}

func (a *app) focusIndex() int {
	for i, p := range a.phones {
		if p == a.focus {
			return i
		}
	}
	return 0
}

// toggleSolo switches between the grid and the focused phone filling the pane.
func (a *app) toggleSolo() {
	if len(a.phones) < 2 {
		return
	}
	a.animate(func() { a.solo = !a.solo })
}

// focusNext gives the keyboard to the next phone. While one phone fills the
// pane, that phone takes its place.
func (a *app) focusNext() {
	n := len(a.phones)
	if n < 2 {
		return
	}
	a.focus = a.phones[(a.focusIndex()+1)%n]
	if a.solo {
		a.relayout()
	} else {
		a.drawChrome()
	}
}

func (a *app) setFocus(p *phone) {
	if a.focus != p {
		a.focus = p
		a.drawChrome()
	}
}

// sendScreenshot saves a full-resolution screenshot of a phone and types its
// path into the agent's pane, so the agent can look at the screen. Without an
// agent, it copies the path.
func (a *app) sendScreenshot(p *phone) {
	png, err := p.idb.Screenshot(a.ctx)
	if err != nil {
		a.flash(err.Error())
		return
	}
	dir := filepath.Join(os.TempDir(), "rexsim")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		a.flash(err.Error())
		return
	}
	name := strings.Map(func(r rune) rune {
		if r == ' ' || r == '/' {
			return '-'
		}
		return r
	}, p.device.Name)
	f, err := os.CreateTemp(dir, name+"-"+time.Now().Format("150405")+"-*.png")
	if err != nil {
		a.flash(err.Error())
		return
	}
	_, err = f.Write(png)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		a.flash(err.Error())
		return
	}
	path := f.Name()
	if a.opts.Agent != "" && rexSend(a.opts.Agent, path+" ") == nil {
		a.flash("Sent a screenshot of " + p.device.Name + " to the agent's input")
		return
	}
	cmd := exec.Command("pbcopy")
	cmd.Stdin = strings.NewReader(path)
	if err := cmd.Run(); err != nil {
		a.flash("Saved " + path)
		return
	}
	a.flash("Copied the screenshot's path: " + path)
}
