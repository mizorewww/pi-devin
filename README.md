# pi-devin-local

[English](README.md) | [简体中文](README_zh.md)

A [Pi](https://pi.dev) package that uses **Devin Local** models inside Pi.

Pi stays the harness. The [Devin CLI](https://docs.devin.ai/cli) owns login and the live model catalog (`devin auth`, `devin models list`). This is not an ACP integration and does not use Zed.

> Fork of [`kashyab12/pi-devin`](https://github.com/kashyab12/pi-devin) (npm `pi-devin`) with additional fixes and features — see [What this fork changes](#what-this-fork-changes). Do not install both: they register the same `devin` provider.

## Why this exists

`pi-devin-auth` treated Devin as Cascade cloud chat. Models like Sol High, Opus 5, and Fable 5 then failed with:

```text
This model is only in Devin Local.
```

Those models are available through the local Devin CLI. This package uses that CLI for auth + catalog, then streams completions into Pi so Pi's tools, sessions, and UI stay in charge.

## Requirements

- Pi Coding Agent 0.86+
- A signed-in [Devin CLI](https://docs.devin.ai/cli) (`devin auth status`), or a signed-in Devin Desktop
- Node 22.19+ (required by Pi 0.86)

The CLI binary is resolved in this order:

1. `$DEVIN_CLI`
2. `~/.local/bin/devin`, Homebrew, `/usr/local/bin/devin`
3. Devin.app's bundled `devin` binary
4. `which devin`

On Windows, discovery checks the CLI installer and Devin Desktop locations, then uses `where.exe` to search PATH. Native executables and `.cmd`/`.bat` wrappers are supported, including paths with spaces. `DEVIN_CLI` takes precedence on every platform.

## Install

From npm (listed in the [package gallery](https://pi.dev/packages)):

```bash
pi install npm:pi-devin-local
```

From git:

```bash
pi install git:github.com/mizorewww/pi-devin
```

Local checkout:

```bash
pi install ~/Developers/pi-devin
```

Restart Pi or run `/reload`. The Chinese README is at [README_zh.md](README_zh.md) (named without a dot so npm keeps English as the package page default).

Upstream is `npm:pi-devin`. Install only one package: both register the same `devin` provider.

## Usage

```text
/login devin
/model devin/swe-2
/model devin/claude-opus-5
/model devin/gpt-5.6-sol
```

Models keep their **family id**; thinking levels belong to pi and each level is
resolved to the matching Devin variant. For SWE-2:

| pi thinking level | model uid sent |
|---|---|
| `medium` | `swe-2-medium` |
| `high` (default) | `swe-2-high` |
| `max` | `swe-2-max` |

Use `/thinking` or `shift+tab` to change the level; levels a family does not ship
are hidden, and `Ctrl+S` in `/thinking` saves the startup default. The same
applies to every other family (`devin/kimi-k3`, `devin/grok-4.6`, …).

`/login devin` seeds `~/.local/share/devin/credentials.toml` from a Devin Desktop
sign-in you already have, and otherwise runs `devin auth login`.

Thinking: the server streams a *summary* of the model's reasoning; the full trace
stays inside the sealed signature and never leaves the server. Pi keeps that
summary together with its signature and replays both on the next request, exactly
like the Devin CLI, so the model keeps its own prior reasoning across tool calls
and turns.

Commands:

- `/devin-status` — CLI path, version, auth
- `/devin-refresh` — reload `devin models list --format json`

The model catalog is cached for six hours in `$XDG_CACHE_HOME/pi-devin/models.json` (or `~/.cache/pi-devin/models.json`). A fresh cache avoids the CLI call at startup; an older cache remains available while it refreshes in the background. Set `PI_OFFLINE=1` to skip automatic catalog refreshes. `/devin-refresh` still requests a refresh explicitly.

## What this is / is not

| This package | Not this package |
|---|---|
| Pi is the agent | Devin taking over the session |
| Devin CLI for auth + catalog | Fake Windsurf OAuth paste flow |
| Live CLI families (Opus 5, Fable 5, Sol, …) | Hardcoded 11-model cloud allowlist |
| Completions streamed into Pi tools | An editor host for Devin |

## What this fork changes

Everything upstream does, plus:

- **Reuses a Devin Desktop sign-in.** Desktop keeps its token in the Electron
  state DB, so the CLI store stayed empty and `/login devin` opened a browser for
  an account that was already signed in. The store is now seeded from
  `windsurfAuthStatus` when it is missing.
- **One model per family, thinking levels via Pi.** `devin/swe-2` + `/thinking max`
  sends `swe-2-max`; levels a family does not ship are hidden instead of silently
  falling back to the default variant.
- **Thinking round-trips.** The server's thinking summary, its sealed signature and
  the redacted flag are kept on the block and replayed on the next request, like
  the Devin CLI does, so the model keeps its own prior reasoning.
- **Request shape aligned with the Devin CLI.** System prompt in the server's
  system slot, matching sampling configuration, trajectory reference and planner
  mode, no stray `execution_id`.
- **Pi payload hooks.** `onPayload` receives the chat request before protobuf
  encoding: `system`, `messages`, `tools`, `modelUid` and `maxOutputTokens`, without
  authentication or transport metadata. Image parts use Pi's `data`/`mimeType`
  shape. Async inspection, in-place edits and returned replacement payloads are
  supported, so `before_provider_request` extensions can observe real requests.

## 0.3.0 compatibility and validation

Requires Pi 0.86+ and Node 22.19+. Single-variant models now also use the CLI family
slug; reselect the model if a saved selection used a raw `MODEL_*` or variant ID.
A cold offline start has no models until a CLI catalog has been cached; run
`/login devin` or `/devin-refresh` while online. No hardcoded model list is used.

The current CLI price format, tool-result images/error flags, concurrent tool streams,
JWT cancellation and session isolation are handled. Incomplete tool JSON and server
errors fail explicitly. The stream has a five-minute idle timeout (overridable with
`timeoutMs`), and requests respect the model's output limit. Cost estimates use the
CLI's reported rates; an omitted cache rate is unknown and displayed as zero.

Verified on 2026-09-29 against Devin CLI 3000.10.27 / Desktop 3.10.27: SWE-2,
GPT-6 Sol and Claude Opus 5.5 completed two-turn tool probes; SWE-2 replayed signed
thinking, and Claude read a tool-result image. This private protocol can change.
See the [audit report](docs/protocol-audit-2026-09-29.md) for findings and coverage
limits, including unverified Gemini-specific thought signatures. On systems without
Devin.app, `DEVIN_CLIENT_VERSION` can override the fallback client version.

## Publish

```bash
bun run typecheck
npm publish --access public
```

This is a standard Pi package (`keywords: ["pi-package"]` + `pi.extensions`).
Once it is on npm with that keyword it is picked up by the
[package gallery](https://pi.dev/packages) within minutes — there is no separate
submission step, and pi has no official namespace for third-party extensions.
If it does not show up, bump the version and publish again to force re-indexing.

## License

MIT. Unofficial. Not affiliated with Cognition.
