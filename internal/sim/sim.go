// Package sim lists and boots simulators with simctl.
package sim

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
)

type Device struct {
	UDID    string
	Name    string
	Runtime string
	Booted  bool
}

func (d Device) Label() string { return d.Name + " · " + d.Runtime }

// Devices lists the available iOS simulators, booted ones first and newer
// runtimes before older ones.
func Devices(ctx context.Context) ([]Device, error) {
	out, err := exec.CommandContext(ctx, "xcrun", "simctl", "list", "devices", "available", "--json").Output()
	if err != nil {
		return nil, fmt.Errorf("simctl list: %w", err)
	}
	var list struct {
		Devices map[string][]struct {
			UDID  string `json:"udid"`
			Name  string `json:"name"`
			State string `json:"state"`
		} `json:"devices"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	var devices []Device
	for runtime, ds := range list.Devices {
		name, ok := runtimeName(runtime)
		if !ok {
			continue
		}
		for _, d := range ds {
			devices = append(devices, Device{UDID: d.UDID, Name: d.Name, Runtime: name, Booted: d.State == "Booted"})
		}
	}
	sort.SliceStable(devices, func(i, j int) bool {
		a, b := devices[i], devices[j]
		if a.Booted != b.Booted {
			return a.Booted
		}
		if a.Runtime != b.Runtime {
			return versionLess(b.Runtime, a.Runtime)
		}
		return a.Name < b.Name
	})
	return devices, nil
}

// runtimeName turns com.apple.CoreSimulator.SimRuntime.iOS-27-0 into iOS 27.0.
func runtimeName(id string) (string, bool) {
	const prefix = "com.apple.CoreSimulator.SimRuntime.iOS-"
	if !strings.HasPrefix(id, prefix) {
		return "", false
	}
	return "iOS " + strings.ReplaceAll(strings.TrimPrefix(id, prefix), "-", "."), true
}

func versionLess(a, b string) bool {
	pa, pb := strings.Split(strings.TrimPrefix(a, "iOS "), "."), strings.Split(strings.TrimPrefix(b, "iOS "), ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		var x, y int
		fmt.Sscan(pa[i], &x)
		fmt.Sscan(pb[i], &y)
		if x != y {
			return x < y
		}
	}
	return len(pa) < len(pb)
}

// Boot starts a simulator and waits until it has finished booting. It
// doesn't open Simulator.app; rexsim reads the framebuffer directly.
func Boot(ctx context.Context, udid string) error {
	if out, err := exec.CommandContext(ctx, "xcrun", "simctl", "bootstatus", udid, "-b").CombinedOutput(); err != nil {
		return fmt.Errorf("boot: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
