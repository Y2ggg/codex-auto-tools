# Changelog

This project follows a lightweight changelog. Git tags and GitHub Releases are
created separately from source commits; no hosted CI/CD is enabled by default.

## 2026-09-07

### `codex-auto` 0.4.1

- Forward the current working directory to the remote TUI by default, while
  preserving explicit `-C`/`--cd` values. This keeps the `Cwd` filter available
  for `codex-auto resume --all`.
- Page through `thread/loaded/list` results so the observer can follow more
  than one page of loaded threads.
- Treat newly introduced app-server progress notifications as activity for the
  Reconnecting watchdog.
- Recognize additional stream-disconnect error fields used by newer app-server
  versions.
- Add `--compat-check` to probe the installed Codex CLI and app-server methods.
- Extend self-tests for cwd forwarding and unknown progress notifications.

### Desktop proxy 0.3.1

- Preserve ordinary Desktop JSONL traffic while keeping recovery RPCs
  transparent to the host.
- Delegate unknown `app-server` subcommands instead of intercepting them.
- Clear the injected `CODEX_CLI_PATH` when delegating to the real Desktop CLI,
  preventing recursive proxy startup.
- Keep the proxy compatible with the same recovery and compatibility checks as
  the CLI wrapper.

### Verification

The release candidate was verified locally with:

```bash
./scripts/verify-repository.sh
node --check lib/codex-capacity-retry.mjs
node --check lib/codex-desktop-proxy.mjs
./bin/codex-auto --self-test
./bin/codex-auto --compat-check
./lib/codex-desktop-proxy --desktop-auto-self-test
```

The compatibility matrix included Codex CLI `0.153.4`, Desktop-bundled CLI
`0.150.0-alpha.8`, and Codex prerelease `0.154.0-alpha.3`.

## Upgrade policy

The wrappers are not pinned to one Codex version, but they do depend on the
documented CLI flags, app-server RPC methods and notifications, and Desktop's
`CODEX_CLI_PATH` launch entry point. After upgrading Codex, run the verification
commands above. A source update is only needed when those checks fail or one of
those compatibility boundaries changes.
