#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
data_dir=${CODEX_AUTO_DATA_DIR:-"$HOME/.local/share/codex-auto-tools"}
command_dir=${CODEX_AUTO_BIN_DIR:-"$HOME/.local/bin"}
create_desktop_icon=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-desktop-icon)
      create_desktop_icon=0
      ;;
    -h|--help)
      printf '%s\n' 'Usage: scripts/install.sh [--no-desktop-icon]'
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

mkdir -p "$data_dir/lib" "$command_dir"
install -m 755 "$project_dir/lib/codex-capacity-retry.mjs" "$data_dir/lib/codex-capacity-retry.mjs"
install -m 755 "$project_dir/lib/codex-desktop-proxy.mjs" "$data_dir/lib/codex-desktop-proxy.mjs"
install -m 755 "$project_dir/lib/codex-desktop-proxy" "$data_dir/lib/codex-desktop-proxy"
install -m 755 "$project_dir/bin/codex-auto" "$command_dir/codex-auto"
install -m 755 "$project_dir/bin/codex-desktop-auto" "$command_dir/codex-desktop-auto"

if [ "$create_desktop_icon" -eq 1 ]; then
  "$project_dir/scripts/create-desktop-app.sh"
fi

printf '%s\n' \
  "Installed codex-auto and codex-desktop-auto in $command_dir" \
  'Run codex-auto --self-test to verify the CLI tool.'
