/**
 * Devin streams thinking as a summary (`delta_thinking`) plus an opaque
 * `delta_signature` and a `delta_signature_type`. The signature is what lets the
 * server verify and continue a reasoning trace, so it has to travel back with the
 * thinking text on the next request — the official Devin CLI does exactly that.
 *
 * Pi stores a single opaque string per thinking block (`thinkingSignature`), so
 * the server's signature type rides along with it. Sealed signatures describe
 * themselves (`sealed.v1.…`), and only `sealed` / `non-sealed` exist, so the
 * common case stores the raw value and the type is only prefixed when it would
 * not be derivable again.
 */

const TYPE_SEPARATOR = "\u001f";
const MODEL_SEPARATOR = "\u001e";

export interface ChatThinking {
  /** Thinking text as sent by the server (already summarized upstream). */
  text: string;
  /** Opaque signature for server-side verification/continuation. */
  signature: string;
  /** `signature_type` reported by the server. */
  signatureType?: string;
  /** Server flagged the trace as redacted by safety filters. */
  redacted?: boolean;
}

export function signatureTypeOf(signature: string): string {
  return signature.startsWith("sealed.") ? "sealed" : "non-sealed";
}

/**
 * Store `signature` in pi's `thinkingSignature` without losing the type or the
 * variant that produced the reasoning. The model uid rides along so a replayed
 * assistant message can still report its generation model (history field 22)
 * after a session restore, when in-memory tracking is gone.
 */
export function packThinkingSignature(signature: string, signatureType?: string, modelUid?: string): string {
  const body = modelUid ? `${signature}${MODEL_SEPARATOR}${modelUid}` : signature;
  if (!signatureType || signatureType === signatureTypeOf(signature)) return body;
  return `${signatureType}${TYPE_SEPARATOR}${body}`;
}

export function unpackThinkingSignature(value: string | undefined): {
  signature?: string;
  signatureType?: string;
  modelUid?: string;
} {
  if (!value) return {};
  const index = value.indexOf(TYPE_SEPARATOR);
  const body = index === -1 ? value : value.slice(index + 1);
  const split = body.lastIndexOf(MODEL_SEPARATOR);
  const signature = split === -1 ? body : body.slice(0, split);
  const modelUid = split === -1 ? undefined : body.slice(split + 1) || undefined;
  if (index === -1) return { signature, signatureType: signatureTypeOf(signature), modelUid };
  return { signatureType: value.slice(0, index), signature, modelUid };
}
