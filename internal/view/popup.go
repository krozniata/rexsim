package view

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"rexsim/internal/companion"
	"rexsim/internal/sim"
	"rexsim/internal/term"
)

// openPopup runs the picker in a floating Rex pane, so the phones keep
// streaming behind it. The picker sends the chosen UDIDs back over a private
// Unix socket, and they arrive on a.picked.
func (a *app) openPopup() error {
	if !inRex() {
		return errors.New("adding simulators needs Rex")
	}
	bin, err := os.Executable()
	if err != nil {
		return err
	}
	dir, err := companion.SocketDir()
	if err != nil {
		return err
	}
	sock := filepath.Join(dir, fmt.Sprintf("%d-pick.sock", os.Getpid()))
	if a.pickLn != nil {
		_ = a.pickLn.Close()
	}
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	a.pickLn = ln

	err = rexCall("session.new_layer", map[string]any{
		"bounds": []float64{0.3, 0.2, 0.4, 0.55},
		"focus":  true,
		"layout": map[string]any{"block": map[string]any{
			"flavor": "com.superlogical.terminal.shell",
			"label":  "rexsim",
			"options": map[string]any{"command": []string{
				bin, "pick", "--result", sock, "--exclude", strings.Join(a.shownUDIDs(), ","),
			}},
		}},
	})
	if err != nil {
		_ = ln.Close()
		return fmt.Errorf("open the picker: %w", err)
	}
	go func() {
		defer ln.Close()
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		data, _ := io.ReadAll(io.LimitReader(conn, 64<<10))
		a.picked <- strings.Fields(string(data))
	}()
	return nil
}

// addPicked connects the simulators chosen in the popup and gives focus back
// to rexsim's pane.
func (a *app) addPicked(udids []string) {
	defer func() { _ = rexCall("session.focus_block", map[string]any{"block_id": os.Getenv("REX_BLOCK")}) }()
	if len(udids) == 0 {
		return
	}
	all, err := sim.Devices(a.ctx)
	if err != nil {
		a.flash(err.Error())
		return
	}
	var chosen []sim.Device
	for _, d := range all {
		for _, u := range udids {
			if d.UDID == u {
				chosen = append(chosen, d)
			}
		}
	}
	if len(chosen) == 0 {
		return
	}
	a.focus = a.add(chosen)[0]
	a.relayout()
}

// Pick runs the picker on its own, as the popup does, and sends the chosen
// UDIDs to the Unix socket at result. Cancelling sends nothing.
func Pick(ctx context.Context, result string, exclude []string) error {
	t, err := term.Open()
	if err != nil {
		return err
	}
	a := &app{ctx: ctx, t: t, events: make(chan any, 64), winch: make(chan os.Signal, 1)}
	signal.Notify(a.winch, syscall.SIGWINCH)
	defer signal.Stop(a.winch)
	go term.ReadEvents(os.Stdin, a.events)

	var chosen []sim.Device
	err = func() error {
		if err := a.updateSize(); err != nil {
			return err
		}
		if err := a.t.EnableInput(); err != nil {
			return err
		}
		a.detectTheme()
		all, err := sim.Devices(ctx)
		if err != nil {
			return err
		}
		chosen, err = a.pick(without(all, exclude), "add simulators")
		return err
	}()
	t.Close()

	if conn, derr := net.Dial("unix", result); derr == nil {
		for _, d := range chosen {
			fmt.Fprintln(conn, d.UDID)
		}
		_ = conn.Close()
	}
	if errors.Is(err, errQuit) {
		return nil
	}
	return err
}
