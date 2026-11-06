package view

import (
	"os"
	"os/exec"
)

// rexSend types text into a Rex block.
func rexSend(block, text string) error {
	return exec.Command("rex", "send", "-s", os.Getenv("REX_SESSION"), "-b", block, text).Run()
}
