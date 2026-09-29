# Protocol and stability audit — 2026-09-29

Scope: all provider source modules, the upstream merge, model discovery, auth reuse,
request/response encoding, streaming, cancellation, transcript mapping and packaging.
Release: pi-devin-local 0.3.0.

## Verified environment

- Devin CLI: `3000.10.27 (bcbe88c7)`.
- Devin Desktop protocol/client version: `3.10.27`.
- Live CLI catalog: 53 families. Model IDs and variants are taken from this catalog.
- Minimum-version checks: Node 22.19.0 tests passed; an isolated Pi 0.86.0 install passed typechecking and regression tests.
- Local Pi dependencies: `@earendil-works/pi-ai` and `pi-coding-agent` 0.87.1.
- Protobuf source of truth: embedded descriptors in
  `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm`.

The descriptors still match the system prompt (2), history (3), configuration (8),
tools (10), trajectory (15), planner mode (20), and model UID (21) request fields.
Execution ID (22) remains omitted. Configuration field types and values are retained.
Thinking/signature/redacted/type remain response fields 9/10/11/21 and history fields
11/12/13/18. The audit also verified tool-result error (history 9), image (history 10),
ModelUsageStats (response 7), stop-reason enums, Metadata, and trajectory enums.
This validates field compatibility with the installed client, not a public API guarantee.

## Findings fixed

| Severity | Trigger and previous behavior | Fix |
| --- | --- | --- |
| High | Interleaved tool deltas or a repeated ID/name header overwrote the active call or mixed its arguments with another call. | Route deltas by call ID and finish each call once. |
| High | Incomplete tool JSON was repaired by the streaming parser and could look executable; server error stop reason 13 looked like success. | Require complete object JSON at completion; surface server error/refusal stops as errors. |
| High | Image-producing tools lost image blocks and their error status when mapped back to Devin. | Preserve images and encode the descriptor-verified tool error flag. |
| High | A failed or logged-out Desktop SQLite lookup fell back to scanning raw pages and could recover an obsolete token. | Use the authoritative SQLite row only; Node 22.19+ supplies SQLite. |
| Medium | CLI `Not logged in` was matched as a successful login, and an existing file overrode a negative CLI result. | Respect the CLI status and require an affirmative login message. |
| Medium | Cancelling the first JWT caller cancelled the shared request used by other sessions; later callers could not cancel their wait. | Share the mint with independent abortable waits and bounded mint timeout. |
| Medium | Pi sessions on one account shared a single cascade/trajectory identity. | Key identities by Pi session and bound the in-memory cache. Calls without a session ID get independent identities. |
| Medium | Requests ignored the catalog's output limit and had no stalled-response timeout; an EOS trailer still waited for HTTP close. | Respect model output limits, add a configurable five-minute idle timeout, finish at EOS. |
| Medium | Truncated protobuf fields could be silently ignored. | Reject malformed fields and bound Connect frame/decompression size. |
| Medium | Current `$… / 1M Input` prices parsed as zero; cache prices used invented multipliers. | Parse current and legacy price formats; use only published cache rates. |
| Medium | Uppercase/private model IDs lost effort mappings; single-variant families used raw variant IDs; SWE's unsuffixed Max mapped to High. | Use CLI labels and normalized suffixes, always retain family IDs, explicitly hide absent levels. |
| Medium | Missing CLI/cache advertised a hardcoded, potentially obsolete cloud list. | Keep an empty catalog until a real CLI catalog or validated cache is available. |
| Medium | Foreign-model signatures could be replayed; signature-only redacted thinking was dropped. | Replay only same-provider/model signatures and preserve empty signed/redacted blocks. |
| Low | Usage in ModelUsageStats (field 7) was ignored when dimension-group metrics were absent. | Read both verified usage representations. |

## Real-service smoke results

Synthetic prompts only; no repository content or real tool actions were sent.
Each tool test asks for `echo_probe`, returns a synthetic result, and expects `PROBE_OK`.

| Model | Tool call | Second turn | Reasoning evidence |
| --- | --- | --- | --- |
| SWE-2, medium | Passed | `PROBE_OK` | Nonempty thinking summary and signature; signed history accepted on turn two. |
| GPT-6 Sol, medium | Passed | `PROBE_OK` | This short probe returned no thinking block. |
| Claude Opus 5.5, medium | Passed | `PROBE_OK` | This short probe returned no thinking block. |

A separate Claude Opus 5.5 probe received a generated red PNG **through a tool result**
and answered `Red`, verifying the repaired image path against the real service.

The final suite has 56 tests: 53 passed on macOS and three Windows-only tests skipped.
Automated regression coverage additionally exercises cancellation, a real HTTP socket
closing mid-stream, idle timeout, EOS without connection close, tool JSON truncation,
interleaved calls, catalog cache behavior, SQLite logout, signature replay, usage,
request configuration, and session isolation. Windows-specific tests require Windows CI.

## Stability assessment and limits

The tested text/tool paths work against the current service and installed client.
That is evidence of current compatibility, not long-duration reliability or coverage of
all 53 families. No load test, Windows execution, or exhaustive model matrix was run.

- GetChatMessage is a private, reverse-engineered protocol. Server changes can break
  field semantics, client version gates, authentication or model routing without notice.
- Gemini-specific `gemini_thought_signature` fields are not round-tripped; Gemini's
  extended reasoning/tool continuity is not certified by this audit. Ordinary sealed
  thinking signatures are covered.
- Files, video and audio are not implemented as Devin multimodal inputs. Image support
  remains dependent on the selected model.
- Cost values are estimates from CLI prices, not billing receipts. Missing cache-write
  prices remain zero/unknown, and one family uses its default variant's rates.
- On macOS, client version comes from Devin.app. Other installations use the verified
  fallback version; `DEVIN_CLIENT_VERSION` can override it when the server raises its gate.
- A stale catalog is intentionally usable during refresh; models may still be removed
  or unavailable to an account. `/devin-refresh` reloads the CLI catalog.
- The provider does not automatically retry a partially emitted completion, avoiding
  duplicate tool calls and duplicate billing. A failed turn must be retried by the harness/user.

Re-run smoke tests and descriptor comparison after a Devin update or a new gate/error.
