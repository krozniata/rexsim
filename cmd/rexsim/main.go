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

	"rexsim/internal/view"
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
		case "pick":
			return pick(args[1:])
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
	fps := flags.Int("fps", 60, "frames per second to stream")
	if err := flags.Parse(args); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	return view.Run(ctx, view.Options{UDIDs: udids, Agent: *agent, FPS: *fps})
}

// pick runs the picker that the ⌃O popup shows, and sends the chosen UDIDs to
// the viewer that opened it.
func pick(args []string) error {
	flags := flag.NewFlagSet("rexsim pick", flag.ContinueOnError)
	result := flags.String("result", "", "the Unix socket to send the chosen UDIDs to")
	exclude := flags.String("exclude", "", "UDIDs to leave out, separated by commas")
	if err := flags.Parse(args); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	return view.Pick(ctx, *result, strings.Split(*exclude, ","))
}
