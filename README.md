# rexsim

An iOS simulator in a [Rex](https://www.superlogical.com/rex) pane. Tap, swipe, scroll and type into one or several simulators beside your coding agent, and send the agent a screenshot.

## How it works

- Meta's `idb_companion` reads the simulator's framebuffer through CoreSimulator and injects HID events. rexsim downloads the pinned v1.7.8 release on first run, checks its sha256 and caches it in `~/Library/Caches/rexsim`. `REXSIM_COMPANION` points at another build.
- rexsim talks gRPC to one companion per simulator over a Unix socket in `/tmp/rexsim-$UID` (mode 0700). It never opens a TCP port.
- Frames arrive as raw BGRA at the size the phone is drawn. Unchanged frames are dropped. The rest go to Rex as kitty graphics through temporary files (`t=t`), so pixel data doesn't pass through the terminal as base64.
- Mouse reports in pixels (mode 1016) map a click to an exact point on the phone. A drag moves the finger live, rather than sending one swipe when you let go.
- Each simulator connects in the background, so a booting one shows as an empty frame while the others stay usable.
- Simulator.app doesn't need to be open.

## Install

```sh
go build -o ~/.local/bin/rexsim ./cmd/rexsim
rexsim install
```

`rexsim install` writes `~/.config/rex/rexsim.lua` and adds `require("rexsim")` to `init.lua`. `rexsim uninstall` removes both.

## Use

Press Shift+Cmd+I beside an agent, or run "Toggle rexsim" from the command palette. It shows every booted simulator, each in a frame with its name below. When none is booted, it lists them all: Space marks one or more and Enter boots and shows them, or a digit or a click shows just that one.

Control the simulator:

| Input | Does |
| --- | --- |
| Click, drag | Tap, swipe |
| Wheel | Scroll |
| Typing, paste | Types into the focused phone, the one clicked last |
| Ctrl+B, Ctrl+L | Home, lock |
| Ctrl+S | Saves a screenshot and types its path into the agent's input |

Control rexsim:

| Input | Does |
| --- | --- |
| Ctrl+F | Shows only the focused phone, filling the pane, or goes back to all of them |
| Ctrl+N | Moves focus to the next phone |
| Ctrl+O | Slides in the list of simulators: choosing one shows or hides it, booting it or shutting it down; Esc closes the list |
| Ctrl+] | Quit |

`rexsim --udid UDID[,UDID…]` shows the given simulators without asking.

## Limits

- Apple silicon only, because the pinned companion build is arm64.
- Landscape is shown, but touches map as if the phone were upright.
- Typing covers the characters on a US keyboard.

## License

MIT. See [LICENSE](LICENSE).
