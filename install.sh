#!/bin/sh
# Installs rexsim and adds it to Rex:
#
#   curl -fsSL https://raw.githubusercontent.com/krozniata/rexsim/main/install.sh | sh
#
# REXSIM_VERSION=0.1.0 installs that release instead of the latest, and
# REXSIM_INSTALL_DIR installs to a directory other than ~/.local/bin.
set -eu

repo=krozniata/rexsim
asset=rexsim-darwin-arm64.tar.gz

fail() {
  echo "rexsim: $*" >&2
  exit 1
}

# Everything happens in main, which runs on the last line, so a download cut
# short doesn't run part of the script.
main() {
  dir=${REXSIM_INSTALL_DIR:-$HOME/.local/bin}

  # uname -m says x86_64 in a shell running under Rosetta, so ask the hardware.
  [ "$(uname -s)" = Darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] ||
    fail "rexsim needs an Apple Silicon Mac"

  case ${REXSIM_VERSION:-} in
  "") url=https://github.com/$repo/releases/latest/download ;;
  v*) url=https://github.com/$repo/releases/download/$REXSIM_VERSION ;;
  *) url=https://github.com/$repo/releases/download/v$REXSIM_VERSION ;;
  esac

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "downloading $url/$asset"
  curl -fsSL -o "$tmp/$asset" "$url/$asset" || fail "couldn't download $url/$asset"
  curl -fsSL -o "$tmp/$asset.sha256" "$url/$asset.sha256" || fail "couldn't download $url/$asset.sha256"
  (cd "$tmp" && shasum -a 256 -c "$asset.sha256" >/dev/null) || fail "the download has the wrong checksum"
  tar -xzf "$tmp/$asset" -C "$tmp" rexsim

  # macOS kills a running rexsim whose file is overwritten in place, so the new
  # binary is moved over the old one instead.
  mkdir -p "$dir"
  mv "$tmp/rexsim" "$dir/rexsim.new"
  mv "$dir/rexsim.new" "$dir/rexsim"
  echo "installed $dir/rexsim"

  "$dir/rexsim" install

  case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "add $dir to your PATH to run rexsim yourself" ;;
  esac
}

main
