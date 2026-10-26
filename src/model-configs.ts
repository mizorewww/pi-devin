import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { buildMetadata } from "./metadata.js";
import { encodeMessage, iterFields } from "./wire.js";

/**
 * `devin models list` renders GetCliModelConfigs — the same RPC the CLI reads
 * its catalog from — but its JSON output drops `ClientModelConfig.supports_images`.
 * The flag is the server's per-model answer to whether image parts are accepted,
 * so we fetch the endpoint ourselves and merge it back into the CLI catalog by
 * model_uid. Verified against devin 3000.11.205 and the embedded descriptors in
 * language_server_macos_arm: response field 1 = repeated ClientModelConfig,
 * ClientModelConfig.model_uid = 22, supports_images = 5 (optional bool; absent
 * means false on the wire).
 */
export interface ClientModelCapabilities {
  supportsImages: boolean;
}

/** Decode GetCliModelConfigsResponse into per-model capabilities. */
export function parseClientModelConfigs(proto: Buffer): Map<string, ClientModelCapabilities> {
  const configs = new Map<string, ClientModelCapabilities>();
  for (const field of iterFields(proto)) {
    if (field.num !== 1 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    let uid: string | undefined;
    let supportsImages = false;
    for (const inner of iterFields(field.value)) {
      if (inner.num === 22 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
        uid = inner.value.toString("utf8");
      } else if (inner.num === 5 && inner.wire === 0) {
        supportsImages = Number(inner.value) !== 0;
      }
    }
    if (uid) configs.set(uid, { supportsImages });
  }
  return configs;
}

/** Same traceparent shape the CLI emits on its RPC calls. */
function sentryTrace(): string {
  return `${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-0`;
}

/**
 * Unary Connect call (`application/proto`, raw message body — no stream frame)
 * mirroring the CLI's auth and metadata.
 */
export async function fetchClientModelCapabilities(args: {
  apiKey: string;
  host: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Map<string, ClientModelCapabilities>> {
  const host = args.host.replace(/\/$/, "");
  // Metadata reuses the resolved/fallback CLI version — the capability lookup
  // must not spawn an extra `devin --version` of its own.
  const body = encodeMessage(1, buildMetadata({ apiKey: args.apiKey }));
  const timeout = AbortSignal.timeout(args.timeoutMs ?? 20_000);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`, {
    method: "POST",
    headers: {
      // Basic <apiKey>-<apiKey> — the CLI's auth scheme; no user_jwt.
      Authorization: `Basic ${args.apiKey}-${args.apiKey}`,
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "Accept-Encoding": "gzip",
      "Sentry-Trace": sentryTrace(),
    },
    body: new Uint8Array(body),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`GetCliModelConfigs HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  let payload = Buffer.from(await resp.arrayBuffer());
  // fetch transparently decodes Content-Encoding; only gunzip if the body is
  // still compressed (e.g. a client that leaves gzip bytes untouched).
  if (payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    payload = gunzipSync(payload);
  }
  return parseClientModelConfigs(payload);
}
