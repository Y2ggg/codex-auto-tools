# Codex Auto Tools

[简体中文](README.md) | English

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

Protocol compatibility has been verified with Codex Desktop `0.147.0-alpha.1.2`. Internal Desktop protocols and launch entry points may change in future releases.

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
```

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

```bash
node --check lib/codex-capacity-retry.mjs
node --check lib/codex-desktop-proxy.mjs
./bin/codex-auto --self-test
./lib/codex-desktop-proxy --desktop-auto-self-test
```

## Disclaimer

This is an unofficial experimental project that relies on the current Codex app-server and locally available Desktop interfaces. Run the self-tests after upgrading Codex.

## License

MIT
