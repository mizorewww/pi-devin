# AGENTS.md — pi-devin-local

Pi package that registers the `devin` provider. Auth and the model catalog come from the local Devin CLI. Pi remains the harness.

## Layout

```
extensions/index.ts   # registerProvider("devin"), /login, /devin-status, /devin-refresh
src/cli.ts            # locate + spawn `devin`
src/credentials.ts    # ~/.local/share/devin/credentials.toml
src/desktop-auth.ts   # reuse a Devin Desktop sign-in when the CLI store is missing
src/models.ts         # `devin models list --format json` → ProviderModelConfig[]
src/thinking.ts       # thinking summary + sealed signature round-trip
src/stream.ts         # streamSimple via GetChatMessage (Connect/protobuf)
src/jwt.ts            # GetUserJwt cache
src/metadata.ts       # Metadata proto (Windsurf/Devin Desktop version gate)
src/wire.ts           # protobuf + Connect framing
src/context-map.ts    # Pi Context → Cognition chat history (+ system prompt for slot 2)
```

## Contract

- `/login devin` must call `devin auth login` when no local credential exists. Reusing the session token a signed-in Devin Desktop already stores on disk is allowed; a custom paste/device flow is not.
- Model IDs must come from `devin models list`, not a hardcoded cloud allowlist.
- One pi model per Devin family: the id is the family slug and pi's thinking level picks the variant (`swe-2` + `max` → `swe-2-max`). Never bake a level into the model id.
- Levels a family does not ship must be `null` in `thinkingLevelMap`, so pi hides them instead of silently falling back. Paid-tier suffixes (`-priority`, `-fast`, `-lightning`) are excluded from thinking levels entirely — they are separate SKUs, not thinking variants.
- Auth mirrors the Devin CLI: `Authorization: Basic <apiKey>-<apiKey>` (the session token doubled with a hyphen) plus a `sentry-trace` header. The CLI never calls `GetUserJwt` — neither does this package; there is no JWT mint anywhere.
- `Metadata` mirrors the CLI's sparse form: `ide_name` `devin-cli`, `ide_version`/`extension_version` = the installed `devin` CLI version, `api_key`, `locale` `en`, `os`, `extension_name`/`ide_type` `chisel`, and field 31 = 366 random bytes as 732 hex chars (fresh per request). No `user_jwt`, `request_id`, `session_id`, `ls_timestamp`, `trigger_id` or `plan_name` — the CLI does not send them.
- The request must mirror the Devin CLI: system prompt in `GetChatMessageRequest.prompt` (2) — never collapsed into the first user turn; `configuration` (8) = num_completions 1, max_tokens, max_newlines 400, temperature 1.0, top_k 40, top_p 0.95; `trajectory_reference` (15) = own uuid + CASCADE/USER_INPUT; `planner_mode` (20) = DEFAULT; `chat_model_uid` (21); `execution_id` (22) = fresh uuid per call; field 28 = the session's `adjective-noun` slug (stable per session). The CLI leaves `system_prompt_cache_options` (13) and `prompt_cache_key` (27) unset; keep them unset.
- Per `ChatMessagePrompt` (3): `message_id` (1) = fresh uuid, `source` (2), `prompt` (3). The CLI does not send `num_tokens` (4) or `safe_for_code_telemetry` (5). The newest input message carries `prompt_cache_options` (8) = `{type: EPHEMERAL(1)}` — a single ephemeral breakpoint at the end of the prompt, mirroring Claude-code style caching. Replayed assistant messages carry `generation_model` (22) = the variant that produced them.
- Connect framing: `application/connect+proto` + `Connect-Protocol-Version: 1` + `Accept-Encoding: gzip`; `Connect-Content-Encoding: gzip` only when the request frame is actually gzipped (the CLI compresses large bodies, not small ones).
- Thinking must round-trip: keep the server's `delta_signature` / `delta_signature_type` on the thinking block and replay `thinking` / `signature` / `thinking_redacted` / `signature_type` (11/12/13/18) on the next request, like the Devin CLI does. The server verifies the trace; dropping it loses the model's own reasoning.
- Reasoning that cannot ride the signed slot — unsigned traces, another provider's plain thinking, or a different Devin family — is **inlined into the assistant message's prompt text** as `<thinking>…</thinking>` instead of being dropped. Silently dropping it loses whatever the reasoning concluded; the model still benefits from seeing it as ordinary transcript text. The opaque signature blob itself is never inlined — only the thinking text.
- The server only sends a thinking *summary* (`delta_thinking`). The full trace stays inside the sealed signature and is not readable client-side.
- Field numbers come from the `exa.api_server_pb` descriptors embedded in Devin's language server binary (`/Applications/Devin.app/.../bin/language_server_macos_arm`) — check them there instead of guessing. The CLI-side wire has also been captured directly via a forwarding proxy (see docs/protocol-audit-2026-09-29.md for the method).
- Do not depend on Zed or ACP. Pi keeps tools, permissions, and the session tree.
- Package must stay installable as a Pi package: `keywords: ["pi-package"]` and `pi.extensions`. The npm name is `pi-devin-local` (upstream owns `pi-devin`), so the gallery lists this fork separately.
