package main

import (
	_ "embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed rexsim.lua
var actionLua string

const requireLine = `require("rexsim")`

func configDir() (string, error) {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "rex"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "rex"), nil
}

// install doesn't resolve symlinks in the binary's path, so a path that a
// package manager keeps stable across upgrades stays in the Lua file.
func install() error {
	bin, err := os.Executable()
	if err != nil {
		return err
	}
	if strings.Contains(bin, string(filepath.Separator)+"go-build") {
		return errors.New("install the binary first, for example with go install, then run rexsim install")
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	luaPath := filepath.Join(dir, "rexsim.lua")
	lua := "-- rexsim install writes this file. Run it again after moving rexsim.\n" +
		"local BIN = " + luaQuote(bin) + "\n" + actionLua
	if err := os.WriteFile(luaPath, []byte(lua), 0o644); err != nil {
		return err
	}
	fmt.Println("wrote", luaPath)

	initPath := filepath.Join(dir, "init.lua")
	s, err := readFile(initPath)
	if err != nil {
		return err
	}
	if !hasRequire(s) {
		if s != "" && !strings.HasSuffix(s, "\n") {
			s += "\n"
		}
		if err := os.WriteFile(initPath, []byte(s+requireLine+"\n"), 0o644); err != nil {
			return err
		}
		fmt.Printf("added %s to %s\n", requireLine, initPath)
	}
	reload()
	fmt.Println("press shift+cmd+i, or run \"Toggle rexsim\" from the command palette, beside an agent")
	return nil
}

func uninstall() error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	luaPath := filepath.Join(dir, "rexsim.lua")
	if err := os.Remove(luaPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	initPath := filepath.Join(dir, "init.lua")
	s, err := readFile(initPath)
	if err != nil {
		return err
	}
	var kept []string
	for line := range strings.Lines(s) {
		if !isRequire(line) {
			kept = append(kept, line)
		}
	}
	if next := strings.Join(kept, ""); next != s {
		if err := os.WriteFile(initPath, []byte(next), 0o644); err != nil {
			return err
		}
		fmt.Printf("removed %s from %s\n", requireLine, initPath)
	}
	reload()
	return nil
}

func reload() {
	if out, err := exec.Command("rex", "config", "reload").CombinedOutput(); err != nil {
		fmt.Printf("reload Rex's config yourself with: rex config reload (%s)\n", strings.TrimSpace(string(out)))
		return
	}
	fmt.Println("reloaded Rex's config")
}

func readFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	return string(b), err
}

func hasRequire(s string) bool {
	for line := range strings.Lines(s) {
		if isRequire(line) {
			return true
		}
	}
	return false
}

func isRequire(line string) bool {
	t := strings.TrimSpace(line)
	return t == requireLine || strings.HasPrefix(t, requireLine+" --")
}

var luaEscapes = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\x00", `\0`)

func luaQuote(s string) string { return `"` + luaEscapes.Replace(s) + `"` }
