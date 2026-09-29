import { randomUUID } from "node:crypto";
import { buildMetadata } from "./metadata.js";
import { encodeMessage, iterFields } from "./wire.js";

export interface MintedUserJwt {
  jwt: string;
  expiresAt: number;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const builtin = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof builtin === "function") return builtin(signals);
  const controller = new AbortController();
  const onAbort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      onAbort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => onAbort(signal.reason), { once: true });
  }
  return controller.signal;
}

export async function mintUserJwt(
  apiKey: string,
  host: string,
  signal?: AbortSignal,
): Promise<MintedUserJwt> {
  const metadata = buildMetadata({
    apiKey,
    sessionId: randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: randomUUID(),
  });
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? anySignal([signal, timeout]) : timeout;
  const resp = await fetch(`${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
    },
    body: new Uint8Array(encodeMessage(1, metadata)),
    signal: combined,
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    throw new Error(`GetUserJwt HTTP ${resp.status}: ${buf.toString("utf8").slice(0, 240)}`);
  }

  let jwt: string | null = null;
  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const value = field.value.toString("utf8");
      if (value.startsWith("eyJ")) {
        jwt = value;
        break;
      }
    }
  }
  if (!jwt) throw new Error("GetUserJwt returned no JWT");

  let expiresAt = Math.floor(Date.now() / 1000) + 600;
  try {
    const payload = jwt.split(".")[1] ?? "";
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (typeof parsed.exp === "number") expiresAt = parsed.exp;
  } catch {
    // keep fallback
  }
  return { jwt, expiresAt };
}

let cache: { jwt: string; expiresAt: number; apiKey: string; host: string } | null = null;
const inFlight = new Map<string, Promise<MintedUserJwt>>();

function waitForJwt(promise: Promise<MintedUserJwt>, signal?: AbortSignal): Promise<MintedUserJwt> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function getCachedUserJwt(apiKey: string, host: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) return cache.jwt;
  const key = `${host}\x1f${apiKey}`;
  let promise = inFlight.get(key);
  if (!promise) {
    // A caller can cancel its own wait without cancelling other sessions' mint.
    const pending = mintUserJwt(apiKey, host).then((minted) => {
      if (inFlight.get(key) === pending) cache = { ...minted, apiKey, host };
      return minted;
    });
    promise = pending;
    inFlight.set(key, pending);
    void pending.finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }).catch(() => {});
  }
  return (await waitForJwt(promise, signal)).jwt;
}

export function clearCachedUserJwt(): void {
  cache = null;
  inFlight.clear();
}
