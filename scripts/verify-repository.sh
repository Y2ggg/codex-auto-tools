#!/bin/sh

set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prohibited_configuration_found=0

if [ -d "$repository_root/.github/workflows" ] &&
    [ -n "$(find "$repository_root/.github/workflows" -mindepth 1 -print -quit)" ]; then
  prohibited_configuration_found=1
fi

for dependabot_config in \
  "$repository_root/.github/dependabot.yml" \
  "$repository_root/.github/dependabot.yaml"
do
  if [ -e "$dependabot_config" ] || [ -L "$dependabot_config" ]; then
    prohibited_configuration_found=1
  fi
done

if [ "$prohibited_configuration_found" -ne 0 ]; then
  echo '本仓库禁止托管 CI/CD 或自动依赖更新配置' >&2
  exit 1
fi

echo 'Repository automation policy check passed.'
