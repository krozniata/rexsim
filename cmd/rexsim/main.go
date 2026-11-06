// Command rexsim shows an iOS simulator in a Rex pane that you can tap,
// swipe and type into.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/krozniata/rexsim/internal/view"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "rexsim:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "install":
			return install()
		case "uninstall":
			return uninstall()
		}
	}
	flags := flag.NewFlagSet("rexsim", flag.ContinueOnError)
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "usage: rexsim [flags] | rexsim install | rexsim uninstall")
		flags.PrintDefaults()
	}
	var udids []string
	flags.Func("udid", "a simulator to show; repeat it or separate UDIDs with commas to show several. Without it, rexsim asks unless one is booted", func(s string) error {
		for _, u := range strings.Split(s, ",") {
			if u = strings.TrimSpace(u); u != "" {
				udids = append(udids, u)
			}
		}
		return nil
	})
	agent := flags.String("agent", "", "the Rex block that ^S sends screenshots to; the Rex action sets it")
	fps := flags.Int("fps", 30, "frames per second to stream")
	if err := flags.Parse(args); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	return view.Run(ctx, view.Options{UDIDs: udids, Agent: *agent, FPS: *fps})
}
