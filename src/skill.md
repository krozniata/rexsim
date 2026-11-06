---
name: rexsim
description: Shows iOS simulators and Android emulators live in a Rex pane beside yours. Use inside Rex (REX_SESSION is set) before running e2e tests, agent-device, Maestro, Detox, XCUITest, Espresso, or anything else that drives a simulator or emulator, and whenever the user asks to see or watch a device.
---

<!-- Installed by "rexsim install". "rexsim uninstall" removes it. -->

# rexsim

rexsim streams simulators and emulators into a Rex pane, where the user can
watch them and tap, swipe and type into them.

## Show the devices you drive

When `REX_SESSION` is set, show a device before you drive it, so the user can
watch:

```sh
{{rexsim}} show                        # every booted simulator and emulator
{{rexsim}} show "iPhone 17" Pixel_9    # by name, UDID, AVD name or adb serial; boots any that aren't running
```

- It adds the devices to the session's rexsim pane, or opens one beside your
  pane, without taking focus. Showing a device that is already shown does
  nothing, so repeat it freely; a device that stopped is reconnected.
- Show the devices the run will use. When a test runner picks booted devices
  itself, name them first so rexsim boots them and the runner finds them
  booted, or run `show` again once the runner has booted them.
- An unknown name fails with a message. `xcrun simctl list devices available`
  and `emulator -list-avds` list the names.
- Without `REX_SESSION` there is no Rex pane; skip it.

## While it runs

- Drive the device with your own tools. rexsim only shows it and passes on
  the user's input.
- The user may tap or type in the pane during a run. Keep that in mind when a
  test fails unexpectedly.
- When the user presses ⌃S in the pane, the path of a screenshot is typed into
  your input.
