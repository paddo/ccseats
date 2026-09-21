#!/bin/sh
# Installs ccseats to ~/.local/bin. Usage: curl -fsSL https://raw.githubusercontent.com/paddo/ccseats/main/install.sh | sh
set -eu
case "$(uname)" in Darwin|Linux) ;; *) echo "ccseats supports macOS and Linux (WSL counts as Linux)" >&2; exit 1 ;; esac
for tool in zsh jq curl; do
  command -v $tool >/dev/null || { echo "ccseats needs $tool. Install it with brew, apt or dnf." >&2; exit 1; }
done
dest="${CCSEATS_BIN:-$HOME/.local/bin}"
mkdir -p "$dest"
curl -fsSL https://raw.githubusercontent.com/paddo/ccseats/main/bin/ccseats -o "$dest/ccseats"
chmod +x "$dest/ccseats"
echo "installed $dest/ccseats"
case ":$PATH:" in *":$dest:"*) ;; *) echo "add $dest to your PATH" ;; esac
echo "next: ccseats init"
