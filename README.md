# Codex Auto Tools

简体中文 | [English](README.en.md)

两个非官方的小工具，用于增强 Codex CLI 和 Codex Desktop 的自动恢复能力。

## 功能

### `codex-auto`

- 遇到 `Selected model is at capacity` 时自动在 `medium` 与 `xhigh` 之间切换。
- 在同一个 thread 中自动继续未完成的任务。
- 检测长时间 Reconnecting，自动中断卡住的 turn 后继续。
- 多个 CLI 实例各自使用独立 app-server，互不干扰。

### `codex-desktop-auto`

- 通过 Codex Desktop 已有的 `CODEX_CLI_PATH` 注入 stdio JSONL 透明代理。
- 提供与 CLI 相同的容量错误和 Reconnecting 自动恢复。
- 普通消息、审批和用户输入保持原样转发。
- 不修改或重新签名原始 Codex Desktop 应用。
- 可创建桌面上的 `Codex Auto.app`，双击即可启动。

## 环境要求

- macOS 12 或更高版本。
- Node.js 18 或更高版本。
- 已安装并登录 Codex CLI。
- Desktop 功能需要 `/Applications/ChatGPT.app` 中的 Codex Desktop。

当前协议兼容性在 Codex Desktop `0.147.0-alpha.1.2` 上完成验证。Desktop 内部协议或启动入口未来可能发生变化。

## 安装

```bash
git clone https://github.com/Y2ggg/codex-auto-tools.git
cd codex-auto-tools
./scripts/install.sh
```

默认安装位置：

- 命令：`~/.local/bin/codex-auto`、`~/.local/bin/codex-desktop-auto`
- 运行文件：`~/.local/share/codex-auto-tools/lib`
- 桌面启动器：`~/Desktop/Codex Auto.app`

不创建桌面图标：

```bash
./scripts/install.sh --no-desktop-icon
```

确保 `~/.local/bin` 已加入 `PATH`。

## 使用

CLI：

```bash
codex-auto
codex-auto --self-test
```

Desktop 必须先完全退出普通 Codex Desktop，然后运行：

```bash
codex-desktop-auto --debug
codex-desktop-auto --debug /path/to/workspace
```

也可以直接双击桌面的 `Codex Auto.app`。只有通过这个命令或桌面图标启动时，Desktop 自动恢复才会生效。

日志位置：

```text
~/.codex/desktop-auto/codex-desktop-auto.log
```

## 配置

```bash
CODEX_CAPACITY_RETRY_MAX=6
CODEX_CAPACITY_RETRY_DELAY_MS=1000
CODEX_RECONNECT_STALL_MS=120000
CODEX_RECONNECT_RECOVERY_MAX=3
CODEX_CAPACITY_RETRY_DEBUG=1
```

Desktop 调试日志通过 `codex-desktop-auto --debug` 开启。

## 恢复策略

- 容量错误：等待失败 turn 完成，切换 reasoning effort，再启动续跑 turn。
- Reconnecting：默认等待 120 秒；仍无流输出则执行 `turn/interrupt`，等待完成后在同一 thread 续跑。
- Reconnecting 恢复保持当前 reasoning effort。
- 用户手动中断或开始新 turn 时，自动恢复会取消。
- 容量错误默认最多重试 6 次，Reconnecting 默认最多恢复 3 次。

## 本地验证

```bash
node --check lib/codex-capacity-retry.mjs
node --check lib/codex-desktop-proxy.mjs
./bin/codex-auto --self-test
./lib/codex-desktop-proxy --desktop-auto-self-test
```

## 说明

这是一个非官方实验工具，依赖 Codex app-server 和 Desktop 当前可用的本地接口。升级 Codex 后建议先运行自测。

## License

MIT
