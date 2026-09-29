import { existsSync, readFileSync } from "node:fs";
import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from "./wire.js";

/**
 * Cognition gates Devin Local-only models (every GPT-5.6 variant: Sol, Terra,
 * Luna) by client ide name. With ide="windsurf" GetChatMessage rejects them
 * with "This model is only in Devin Local."; with ide="devin-desktop" the
 * server serves them and the response header echoes the exact model
 * (verified: "GPT-5.6 Sol High Thinking" for gpt-5-6-sol-high, 2026-08-29).
 */
// Verified against Devin Desktop 3.10.27 during the 0.3.0 protocol audit.
const FALLBACK_WINDSURF_VERSION = "3.10.27";
const PRODUCT_JSON =
  "/Applications/Devin.app/Contents/Resources/app/product.json";

function desktopWindsurfVersion(): string {
  const override = process.env.DEVIN_CLIENT_VERSION;
  if (override && /^\d+\.\d+\.\d+$/.test(override)) return override;
  try {
    if (!existsSync(PRODUCT_JSON)) return FALLBACK_WINDSURF_VERSION;
    const product = JSON.parse(readFileSync(PRODUCT_JSON, "utf8")) as {
      windsurfVersion?: string;
    };
    return product.windsurfVersion || FALLBACK_WINDSURF_VERSION;
  } catch {
    return FALLBACK_WINDSURF_VERSION;
  }
}

export const CLIENT_VERSION = desktopWindsurfVersion();
export const CLIENT_IDE = "devin-desktop";

export interface MetadataInput {
  apiKey: string;
  userJwt?: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  version?: string;
  ide?: string;
}

export function buildMetadata(input: MetadataInput): Buffer {
  const version = input.version ?? CLIENT_VERSION;
  const ide = input.ide ?? CLIENT_IDE;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const parts: Buffer[] = [
    encodeString(1, ide),
    encodeString(2, version),
    encodeString(3, input.apiKey),
    encodeString(4, "en"),
    encodeString(5, os),
    encodeString(7, version),
    encodeVarintField(9, input.requestId),
    encodeString(10, input.sessionId),
    encodeString(12, ide),
    encodeMessage(16, encodeTimestampBody()),
    encodeString(25, input.triggerId),
    encodeString(26, "Unset"),
    encodeString(28, ide),
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}
