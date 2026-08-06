#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
app_path=${1:-"$HOME/Desktop/Codex Auto.app"}
app_bundle=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
contents_dir="$app_path/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
source_icon="$app_bundle/Contents/Resources/icon-codex-dark-color.png"
fallback_icon="$app_bundle/Contents/Resources/app.icns"
icon_work_dir=

case "$app_path" in
  *.app) ;;
  *)
    printf '%s\n' 'Desktop launcher path must end in .app' >&2
    exit 2
    ;;
esac

cleanup_icon_work_dir() {
  if [ -n "$icon_work_dir" ] && [ -d "$icon_work_dir" ]; then
    find "$icon_work_dir" -depth -delete
  fi
}

trap cleanup_icon_work_dir EXIT HUP INT TERM

mkdir -p "$macos_dir" "$resources_dir"
install -m 644 "$project_dir/assets/Info.plist" "$contents_dir/Info.plist"
install -m 755 "$project_dir/assets/codex-auto-launcher" "$macos_dir/codex-auto-launcher"

if [ -f "$source_icon" ]; then
  icon_work_dir=$(mktemp -d /private/tmp/codex-auto-icon.XXXXXX)
  iconset_dir="$icon_work_dir/codex-auto.iconset"
  mkdir "$iconset_dir"
  sips -z 16 16 "$source_icon" --out "$iconset_dir/icon_16x16.png" >/dev/null
  sips -z 32 32 "$source_icon" --out "$iconset_dir/icon_16x16@2x.png" >/dev/null
  sips -z 32 32 "$source_icon" --out "$iconset_dir/icon_32x32.png" >/dev/null
  sips -z 64 64 "$source_icon" --out "$iconset_dir/icon_32x32@2x.png" >/dev/null
  sips -z 128 128 "$source_icon" --out "$iconset_dir/icon_128x128.png" >/dev/null
  sips -z 256 256 "$source_icon" --out "$iconset_dir/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "$source_icon" --out "$iconset_dir/icon_256x256.png" >/dev/null
  sips -z 512 512 "$source_icon" --out "$iconset_dir/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "$source_icon" --out "$iconset_dir/icon_512x512.png" >/dev/null
  sips -z 1024 1024 "$source_icon" --out "$iconset_dir/icon_512x512@2x.png" >/dev/null
  iconutil -c icns "$iconset_dir" -o "$resources_dir/codex-auto.icns"
elif [ -f "$fallback_icon" ]; then
  install -m 644 "$fallback_icon" "$resources_dir/codex-auto.icns"
else
  printf '%s\n' 'Warning: Codex icon not found; the launcher will use the default app icon.' >&2
fi

touch "$app_path"
codesign --force --deep --sign - "$app_path"
launch_services=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -x "$launch_services" ]; then
  "$launch_services" -f "$app_path"
fi

printf 'Created desktop launcher: %s\n' "$app_path"
