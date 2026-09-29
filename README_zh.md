# pi-devin-local

**简体中文** | [English](README.md)

一个 [Pi](https://pi.dev) 包，让 Pi 里可以直接使用 **Devin Local** 模型。

Pi 仍然是 harness。[Devin CLI](https://docs.devin.ai/cli) 负责登录与实时模型目录（`devin auth`、`devin models list`）。这不是 ACP 集成，也不依赖 Zed。

> 这是 [`kashyab12/pi-devin`](https://github.com/kashyab12/pi-devin)（npm 上的 `pi-devin`）的 fork，包含额外的修复和功能 —— 见[本 fork 改了什么](#本-fork-改了什么)。两者**不能同时安装**：它们注册的是同一个 `devin` provider。

## 为什么会有这个包

`pi-devin-auth` 把 Devin 当成 Cascade 云端聊天，于是 Sol High、Opus 5、Fable 5 这类模型会直接失败：

```text
This model is only in Devin Local.
```

这些模型只能通过本地 Devin CLI 使用。本包用 CLI 完成认证 + 拉取目录，再把补全流式接进 Pi，从而让 Pi 的工具、会话和界面继续当家。

## 环境要求

- Pi Coding Agent 0.86+
- 已登录的 [Devin CLI](https://docs.devin.ai/cli)（`devin auth status`），或已登录的 Devin Desktop
- Node 22.19+（Pi 0.86 的要求）

CLI 可执行文件的查找顺序：

1. `$DEVIN_CLI`
2. `~/.local/bin/devin`、Homebrew、`/usr/local/bin/devin`
3. Devin.app 内置的 `devin` 二进制
4. `which devin`

Windows 上会检查 CLI 安装器和 Devin Desktop 的安装路径，然后使用 `where.exe` 搜索 PATH。支持原生可执行文件和 `.cmd` / `.bat` 包装脚本，包括带空格的路径。所有平台都优先使用 `DEVIN_CLI`。

## 安装

从 npm（已收录在[官方包目录](https://pi.dev/packages)）：

```bash
pi install npm:pi-devin-local
```

从 git：

```bash
pi install git:github.com/mizorewww/pi-devin
```

本地仓库：

```bash
pi install ~/Developers/pi-devin
```

装完重启 Pi，或执行 `/reload`。

上游包是 `npm:pi-devin`。两者只能安装一个：它们注册的是同一个 `devin` provider。

## 使用

```text
/login devin
/model devin/swe-2
/model devin/claude-opus-5
/model devin/gpt-5.6-sol
```

模型使用 **family 级 ID**；思考档位由 Pi 管理，每个档位会映射到对应的 Devin variant。以 SWE-2 为例：

| Pi 思考档位 | 实际发送的 model uid |
|---|---|
| `medium` | `swe-2-medium` |
| `high`（默认） | `swe-2-high` |
| `max` | `swe-2-max` |

用 `/thinking` 或 `shift+tab` 切换档位；该 family 没有的档位会被隐藏，在 `/thinking` 里按 `Ctrl+S` 可保存为启动默认值。其他 family（`devin/kimi-k3`、`devin/grok-4.6` 等）同理。

`/login devin` 会优先复用你已有的 Devin Desktop 登录态来生成 `~/.local/share/devin/credentials.toml`，没有时才调用 `devin auth login`。

关于思维链：服务端只流式下发模型推理的**摘要**，完整思维链封在 sealed 签名里、永远不出服务端。Pi 会把摘要连同签名一起保留，并在下一次请求中回传 —— 和 Devin CLI 的行为一致 —— 因此模型在多次工具调用和多轮对话中都能拿回自己此前的推理。

命令：

- `/devin-status` — CLI 路径、版本、认证状态
- `/devin-refresh` — 重新执行 `devin models list --format json` 拉取目录

模型目录缓存有效期为六小时，存放在 `$XDG_CACHE_HOME/pi-devin/models.json`（默认是 `~/.cache/pi-devin/models.json`）。缓存未过期时启动无需调用 CLI；过期后会先使用缓存，再在后台刷新。设置 `PI_OFFLINE=1` 可跳过自动刷新；`/devin-refresh` 仍可手动刷新。

## 这个包是 / 不是什么

| 是 | 不是 |
|---|---|
| Pi 作为 agent | Devin 接管会话 |
| 用 Devin CLI 做认证 + 目录 | 伪造的 Windsurf OAuth 粘贴流程 |
| 实时的 CLI family（Opus 5、Fable 5、Sol……） | 硬编码的 11 个云端模型白名单 |
| 补全流式接入 Pi 的工具 | 给 Devin 当编辑器宿主 |

## 本 fork 改了什么

上游有的这里都有，另外还有：

- **复用 Devin Desktop 登录态。** Desktop 把 token 存在 Electron 的 state DB 里，所以 CLI 的凭据文件一直是空的，`/login devin` 会为一个其实已登录的账号打开浏览器。现在凭据文件缺失时会从 `windsurfAuthStatus` 自动补齐。
- **每个 family 一个模型，思考档位交给 Pi。** `devin/swe-2` + `/thinking max` 会发送 `swe-2-max`；该 family 没有的档位会被隐藏，而不是悄悄回退到默认 variant。
- **思维链完整往返。** 服务端下发的思考摘要、sealed 签名和 redacted 标记都会保存在 thinking block 上，并在下一次请求中回传（与 Devin CLI 一致），模型因此能保留自己此前的推理。
- **请求形状与 Devin CLI 对齐。** 系统提示放在服务端的 system 槽位，采样配置、trajectory reference、planner mode 均对齐，并移除了多余的 `execution_id`。

## 发布

```bash
bun run typecheck
npm publish --access public
```

这是一个标准的 Pi 包（`keywords: ["pi-package"]` + `pi.extensions`）。只要带该关键字发布到 npm，几分钟内就会被[官方包目录](https://pi.dev/packages)收录 —— 没有单独的投稿流程，pi 也没有面向第三方扩展的官方 namespace。若长时间没被收录，bump 一下版本重新发布即可强制重新索引。

## 许可

MIT。非官方，与 Cognition 无隶属关系。
