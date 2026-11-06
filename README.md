# rexsim

An iOS simulator in a [Rex](https://www.superlogical.com/rex) pane. Tap, swipe, scroll and type into one or several simulators beside your coding agent, and send the agent a screenshot.

## How it works

- Meta's `idb_companion` reads the simulator's framebuffer through CoreSimulator and injects HID events. rexsim downloads the pinned v1.7.8 release on first run, checks its sha256 and caches it in `~/Library/Caches/rexsim`. `REXSIM_COMPANION` points at another build.
- rexsim talks gRPC to one companion per simulator over a Unix socket in `/tmp/rexsim-$UID` (mode 0700). It never opens a TCP port.
- Frames arrive as raw BGRA at the size the phone is drawn. Unchanged frames are dropped. The rest go to Rex as kitty graphics through temporary files (`t=t`), so pixel data doesn't pass through the terminal as base64.
- Mouse reports in pixels (mode 1016) map a click to an exact point on the phone. A drag moves the finger live, rather than sending one swipe when you let go.
- Simulator.app doesn't need to be open.

## Install

```sh
go build -o ~/.local/bin/rexsim ./cmd/rexsim
rexsim install
```

`rexsim install` writes `~/.config/rex/rexsim.lua` and adds `require("rexsim")` to `init.lua`. `rexsim uninstall` removes both.

## Use

Press Shift+Cmd+I beside an agent, or run "Toggle rexsim" from the command palette. With one booted simulator it shows that one. With several, it lists every simulator with the booted ones marked: Enter shows the marked ones, each in a frame with its name below, Space marks or unmarks one, a digit or a click shows just that one.

| Input | Does |
| --- | --- |
| Click, drag | Tap, swipe |
| Wheel | Scroll |
| Typing, paste | Types into the phone clicked last |
| Ctrl+B, Ctrl+L | Home, lock |
| Ctrl+S | Saves a screenshot and types its path into the agent's input |
| Ctrl+G | Cycles the layout: Auto, Grid, Row, Column |
| Ctrl+] | Quit |

`rexsim --udid UDID[,UDID…]` shows the given simulators without asking.

## Limits

- Apple silicon only, because the pinned companion build is arm64.
- Landscape is shown, but touches map as if the phone were upright.
- Typing covers the characters on a US keyboard.

## License

MIT. See [LICENSE](LICENSE).
