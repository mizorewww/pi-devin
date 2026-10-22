import { randomBytes } from "node:crypto";
import { devinVersion } from "./cli.js";
import { encodeString } from "./wire.js";

/**
 * Client identity mirrors what the Devin CLI (chisel-agent) actually sends on
 * the wire, verified against a captured GetChatMessage request from
 * devin 3000.11.92 (2026-10-22): ide_name = "devin-cli", extension_name and
 * ide_type = "chisel", ide_version/extension_version = the CLI version.
 *
 * Earlier revisions impersonated Devin Desktop ("devin-desktop") because
 * Cognition gated Devin Local-only models (the GPT-5.6 family) by ide name;
 * the CLI's own identity clears that gate for the same catalog entries.
 */
const FALLBACK_CLIENT_VERSION = "3000.11.92";
const IDE_NAME = "devin-cli";
const CHISEL = "chisel";

let resolvedVersion: string | undefined;
let versionRequest: Promise<string> | null = null;

/** Best-known CLI version without blocking; upgraded by ensureClientVersion(). */
export const CLIENT_VERSION = FALLBACK_CLIENT_VERSION;
export const CLIENT_IDE = IDE_NAME;

/**
 * Resolve the installed `devin` CLI version once per process. Metadata should
 * report the real binary's version — a stale hardcoded one can trip the
 * server-side minimum-version gate in either direction.
 */
export function ensureClientVersion(): Promise<string> {
  if (resolvedVersion) return Promise.resolve(resolvedVersion);
  if (!versionRequest) {
    versionRequest = devinVersion()
      .then((raw) => {
        const parsed = raw?.match(/\d+\.\d+\.\d+/)?.[0];
        resolvedVersion = parsed ?? FALLBACK_CLIENT_VERSION;
        return resolvedVersion;
      })
      .catch(() => {
        resolvedVersion = FALLBACK_CLIENT_VERSION;
        return resolvedVersion;
      })
      .finally(() => {
        versionRequest = null;
      });
  }
  return versionRequest;
}

export interface MetadataInput {
  apiKey: string;
}

/**
 * Sparse Metadata message, identical to the CLI's: no request_id, session_id,
 * ls_timestamp, trigger_id, plan_name or user_jwt — the CLI authenticates with
 * the HTTP Authorization header instead. Field 31 carries 366 bytes of fresh
 * per-request randomness encoded as 732 lowercase hex chars (the CLI's own
 * `f` field has the same shape and changes on every call).
 */
export function buildMetadata(input: MetadataInput): Buffer {
  const version = resolvedVersion ?? FALLBACK_CLIENT_VERSION;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  return Buffer.concat([
    encodeString(1, IDE_NAME),
    encodeString(2, version),
    encodeString(3, input.apiKey),
    encodeString(4, "en"),
    encodeString(5, os),
    encodeString(7, version),
    encodeString(12, CHISEL),
    encodeString(28, CHISEL),
    encodeString(31, randomBytes(366).toString("hex")),
  ]);
}
