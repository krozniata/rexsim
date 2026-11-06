package view

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// inRex reports whether rexsim runs in a Rex pane, with the rex command to
// reach the server.
func inRex() bool {
	if os.Getenv("REX_SESSION") == "" || os.Getenv("REX_BLOCK") == "" {
		return false
	}
	_, err := exec.LookPath("rex")
	return err == nil
}

// rexCall calls a Rex server API method in rexsim's session.
func rexCall(method string, args map[string]any) error {
	session := os.Getenv("REX_SESSION")
	args["session_id"] = session
	body, err := json.Marshal(args)
	if err != nil {
		return err
	}
	if out, err := exec.Command("rex", "api", "call", "-s", session, method, string(body)).CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %s", method, strings.TrimSpace(string(out)))
	}
	return nil
}

// rexSend types text into a Rex block.
func rexSend(block, text string) error {
	return exec.Command("rex", "send", "-s", os.Getenv("REX_SESSION"), "-b", block, text).Run()
}
