# Codex Auto Tools

[简体中文](README.md) | English

Current implementation: `codex-auto` `0.4.1` and Desktop proxy `0.3.1`. See
[CHANGELOG.md](CHANGELOG.md) for the detailed changes.

Two unofficial utilities that add automatic recovery to Codex CLI and Codex Desktop.

## Features

### `codex-auto`

- Toggles between `medium` and `xhigh` when the selected model is at capacity.
- Continues unfinished work in the same thread.
- Detects prolonged Reconnecting states, interrupts the stalled turn, and continues automatically.
- Runs each CLI instance with an independent app-server so multiple terminals do not interfere with one another.

### `codex-desktop-auto`

- Injects a transparent stdio JSONL proxy through Codex Desktop's existing `CODEX_CLI_PATH` entry point.
- Provides the same capacity-error and Reconnecting recovery as the CLI tool.
- Forwards normal messages, approvals, and user input unchanged.
- Does not modify or re-sign the original Codex Desktop application.
- Can create a desktop `Codex Auto.app` launcher for one-click startup.

## Requirements

- macOS 12 or later.
- Node.js 18 or later.
- Codex CLI installed and authenticated.
- The Desktop integration requires Codex Desktop at `/Applications/ChatGPT.app`.

The current implementation has been compatibility-checked against Codex CLI `0.153.4` and the Desktop-bundled CLI `0.150.0-alpha.8`. These are public verification baselines, not hard version pins. The Desktop proxy depends on the current local protocol and launch entry point, so run the self-tests after upgrading either Codex installation.

## Installation

```bash
git clone https://github.com/Y2ggg/codex-auto-tools.git
cd codex-auto-tools
./scripts/install.sh
```

Default installation paths:

- Commands: `~/.local/bin/codex-auto` and `~/.local/bin/codex-desktop-auto`
- Runtime files: `~/.local/share/codex-auto-tools/lib`
- Desktop launcher: `~/Desktop/Codex Auto.app`

Install without creating the desktop launcher:

```bash
./scripts/install.sh --no-desktop-icon
```

Make sure `~/.local/bin` is included in `PATH`.

## Usage

CLI:

```bash
codex-auto
codex-auto --self-test
codex-auto --compat-check
```

`codex-auto` passes the current directory explicitly to the remote TUI. This keeps the `Cwd` filter available in the session picker when using `codex-auto resume --all`; an explicit `-C/--cd` value is preserved.

Fully quit the regular Codex Desktop application before launching the wrapped version:

```bash
codex-desktop-auto --debug
codex-desktop-auto --debug /path/to/workspace
```

You can also double-click `Codex Auto.app` on the desktop. Desktop recovery is active only when Codex is launched through this command or the desktop launcher.

Log file:

```text
~/.codex/desktop-auto/codex-desktop-auto.log
```

## Configuration

```bash
CODEX_CAPACITY_RETRY_MAX=12
CODEX_CAPACITY_RETRY_DELAY_MS=1000
CODEX_CAPACITY_RETRY_MAX_DELAY_MS=60000
CODEX_RECONNECT_STALL_MS=20000
CODEX_RECONNECT_RECOVERY_MAX=3
CODEX_CAPACITY_RETRY_DEBUG=1
```

Use `codex-desktop-auto --debug` to enable Desktop proxy debug logging.

## Recovery behavior

- Capacity error: waits for the failed turn to complete, switches the reasoning effort, and starts a continuation turn.
- Capacity retries use exponential backoff: by default they wait 1, 2, 4, 8, 16, 32, 60, 60… seconds, capped at the maximum delay.
- Reconnecting: waits 20 seconds by default; if the Turn fails first, continues immediately; otherwise, if no stream output resumes, sends `turn/interrupt` and continues in the same thread.
- Reconnecting recovery preserves the current reasoning effort.
- A manual interrupt or a newer user turn cancels the old automatic recovery; a newly started user turn also resets that thread's recovery counters.
- Capacity failures retry up to 12 times by default; Reconnecting recovery runs up to 3 times.

## Local verification

This repository does not use GitHub Actions, automated Dependabot updates, or any other hosted CI/CD. By default, GitHub is used only for source storage, version control, code collaboration, branches, tags, and releases. A push, pull request, or tag does not automatically run builds, tests, packaging, or release verification.

Run all verification locally and manually as needed:

```bash
./scripts/verify-repository.sh
node --check lib/codex-capacity-retry.mjs
node --check lib/codex-desktop-proxy.mjs
./bin/codex-auto --self-test
./bin/codex-auto --compat-check
./lib/codex-desktop-proxy --desktop-auto-self-test
```

Generate and verify release assets locally, then upload them manually to the GitHub Release. Explicit user authorization is required before enabling any remote build, test, dependency-update, packaging, deployment, or release automation.

## Disclaimer

This is an unofficial experimental project that relies on the current Codex app-server and locally available Desktop interfaces. `codex-auto` preserves user CLI arguments and only adds its local `--remote` endpoint plus a default `--cd`; recovery is implemented by observing RPC notifications and starting continuation turns. The Desktop proxy forwards ordinary JSONL messages unchanged, but intentionally injects RPC requests when recovery is needed.

The project is therefore not pinned to one Codex version, but it is not entirely version-independent either: CLI `--remote`/`--cd`, app-server methods and notifications, and Desktop's `CODEX_CLI_PATH` launch entry point are compatibility boundaries. A Codex upgrade usually needs no synchronized code change; update the adapter only when a self-test fails or one of those boundaries changes. After an upgrade, run:

```bash
codex --version
./bin/codex-auto --self-test
./bin/codex-auto --compat-check
./lib/codex-desktop-proxy --desktop-auto-self-test
```

To check the Codex binary bundled with Desktop as well:

```bash
CODEX_CAPACITY_RETRY_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
  ./bin/codex-auto --compat-check
```

Official references: [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands) | [Codex app-server](https://learn.chatgpt.com/docs/app-server)

## License

MIT
