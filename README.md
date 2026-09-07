# Codex Auto Tools

简体中文 | [English](README.en.md)

当前实现：`codex-auto` `0.4.1`，Desktop proxy `0.3.1`。详细变更见
[CHANGELOG.md](CHANGELOG.md)。

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

当前实现已针对 Codex CLI `0.153.4` 和 Desktop 内置 CLI `0.150.0-alpha.8` 完成兼容性验证。这些是公开的验证基线，不是硬编码的版本锁定；Desktop 代理依赖当前本地协议和启动入口，升级任一 Codex 后请先运行自测。

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
codex-auto --compat-check
```

`codex-auto` 会把当前目录显式传给远程 TUI。这样使用 `codex-auto resume --all` 时仍然可以在会话选择器中切换 `Cwd` 筛选；如果已经传入 `-C/--cd`，则保留显式目录。

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
CODEX_CAPACITY_RETRY_MAX=12
CODEX_CAPACITY_RETRY_DELAY_MS=1000
CODEX_CAPACITY_RETRY_MAX_DELAY_MS=60000
CODEX_RECONNECT_STALL_MS=20000
CODEX_RECONNECT_RECOVERY_MAX=3
CODEX_CAPACITY_RETRY_DEBUG=1
```

Desktop 调试日志通过 `codex-desktop-auto --debug` 开启。

## 恢复策略

- 容量错误：等待失败 turn 完成，切换 reasoning effort，再启动续跑 turn。
- 容量重试采用指数退避：默认等待 1、2、4、8、16、32、60、60…秒，达到最大间隔后封顶。
- Reconnecting：默认等待 20 秒；期间流恢复则继续原 Turn；若 Turn 先以失败结束则立即续跑，否则执行 `turn/interrupt` 后在同一 thread 续跑。
- Reconnecting 恢复保持当前 reasoning effort。
- 用户手动中断或开始新 turn 时，旧的自动恢复会取消；手动开始新 turn 还会重置该 thread 的恢复次数。
- 容量错误默认最多重试 12 次，Reconnecting 默认最多恢复 3 次。

## 本地验证

本仓库不使用 GitHub Actions、Dependabot 自动更新或其他托管 CI/CD。GitHub 默认仅用于代码存储、版本管理、代码协作、分支、tag 和 release；push、pull request 或 tag 不会自动执行构建、测试、打包或发布验证。

所有验证均需在本地按需手动执行：

```bash
./scripts/verify-repository.sh
node --check lib/codex-capacity-retry.mjs
node --check lib/codex-desktop-proxy.mjs
./bin/codex-auto --self-test
./bin/codex-auto --compat-check
./lib/codex-desktop-proxy --desktop-auto-self-test
```

Release 资产应在本地生成并验证，确认无误后手动上传到 GitHub Release。启用任何远端自动构建、测试、依赖升级、打包、部署或发布流程前，必须先取得用户明确授权。

## 说明

这是一个非官方实验工具，依赖 Codex app-server 和 Desktop 当前可用的本地接口。`codex-auto` 会保留用户 CLI 参数，只额外注入本地 `--remote` 和默认 `--cd`；恢复功能通过旁路 RPC 观察和补发续跑请求实现。Desktop 代理会原样转发普通 JSONL 消息，但会在恢复时主动补发 RPC。

因此它不是“只适配一个固定 Codex 版本”，但也不是完全与版本无关：CLI 的 `--remote`、`--cd` 和 app-server 方法/通知属于需要持续观察的接口，Desktop 的 `CODEX_CLI_PATH` 更是本地集成入口。Codex 升级后通常不需要同步改代码；只有自测失败、参数语义变化、app-server 事件字段变化或 Desktop 启动入口变化时才需要迭代。建议升级后手动执行：

```bash
codex --version
./bin/codex-auto --self-test
./bin/codex-auto --compat-check
./lib/codex-desktop-proxy --desktop-auto-self-test
```

若要同时检查 Desktop 内置的 Codex 二进制：

```bash
CODEX_CAPACITY_RETRY_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
  ./bin/codex-auto --compat-check
```

相关官方参考：[Codex CLI 命令](https://learn.chatgpt.com/docs/developer-commands) | [Codex app-server](https://learn.chatgpt.com/docs/app-server)

## License

MIT
