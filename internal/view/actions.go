package view

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"rexsim/internal/sim"
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

// openMore opens a popup that lists the simulators that aren't shown, and
// adds the ones chosen there.
func (a *app) openMore() {
	all, err := sim.Devices(a.ctx)
	if err != nil {
		a.flash(err.Error())
		return
	}
	if len(without(all, a.shownUDIDs())) == 0 {
		a.flash("Every simulator is already shown")
		return
	}
	if err := a.openPopup(); err != nil {
		a.flash(err.Error())
	}
}

func (a *app) shownUDIDs() []string {
	udids := make([]string, len(a.phones))
	for i, p := range a.phones {
		udids[i] = p.device.UDID
	}
	return udids
}

// closeFocused takes the focused phone out of the pane and shuts its
// simulator down. The shutdown runs in the background, because it takes a
// second or two.
func (a *app) closeFocused() error {
	if len(a.phones) == 1 {
		return errQuit
	}
	i := a.focusIndex()
	a.animate(func() {
		closed := a.phones[i]
		a.phones = append(a.phones[:i], a.phones[i+1:]...)
		a.focus = a.phones[min(i, len(a.phones)-1)]
		if len(a.phones) < 2 {
			a.solo = false
		}
		closed.close()
		go func() { _ = exec.Command("xcrun", "simctl", "shutdown", closed.device.UDID).Run() }()
		a.flash("Shutting down " + closed.device.Name)
	})
	return nil
}

func (a *app) cycleLayout() {
	a.animate(func() { a.mode = (a.mode + 1) % 4 })
	a.flash("Layout: " + a.mode.String())
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

// moveFocus gives the keyboard to the next or previous phone. While one
// phone fills the pane, that phone takes its place.
func (a *app) moveFocus(step int) {
	n := len(a.phones)
	if n < 2 {
		return
	}
	a.focus = a.phones[((a.focusIndex()+step)%n+n)%n]
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
	path := filepath.Join(dir, name+"-"+time.Now().Format("150405")+".png")
	if err := os.WriteFile(path, png, 0o600); err != nil {
		a.flash(err.Error())
		return
	}
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
