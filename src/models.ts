import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { runDevin } from "./cli.js";

export interface DevinVariant {
  model_uid: string;
  label: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  cost_tier?: string;
  cost_summary?: string;
  is_new?: boolean;
  is_beta?: boolean;
}

export interface DevinFamily {
  family_label: string;
  family_uid: string;
  slug: string;
  aliases?: string[];
  variants: DevinVariant[];
}

export interface DevinCatalog {
  families: DevinFamily[];
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseCost(summary?: string): ProviderModelConfig["cost"] {
  const rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!summary) return rates;
  // CLI releases use both "$5/MTok In" and "$5 / 1M Input".
  for (const match of summary.matchAll(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*(?:MTok|1M)\s+(Cached input|Cache read|Cache write|Cache creation|Input|Output|In|Out)\b/gi)) {
    const kind = match[2].toLowerCase();
    const key = kind.startsWith("cached") || kind === "cache read" ? "cacheRead"
      : kind.startsWith("cache") ? "cacheWrite" : kind.startsWith("out") ? "output" : "input";
    rates[key] = Number(match[1]);
  }
  // Do not invent provider-specific cache multipliers when the CLI omits them.
  return rates;
}

function variantKey(uid: string): string | null {
  uid = uid.toLowerCase().replaceAll("_", "-");
  const suffixes = [
    "none-priority",
    "low-priority",
    "medium-priority",
    "high-priority",
    "xhigh-priority",
    "max-priority",
    "low-fast",
    "medium-fast",
    "high-fast",
    "xhigh-fast",
    "max-fast",
    "thinking-1m",
    "thinking",
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "minimal",
  ];
  for (const suffix of suffixes) {
    if (uid === suffix || uid.endsWith(`-${suffix}`)) return suffix;
  }
  return null;
}

function thinkingFromSuffix(suffix: string | null): keyof ThinkingLevelMap | null {
  if (!suffix) return null;
  if (suffix === "none" || suffix === "none-priority") return "off";
  if (suffix === "minimal") return "minimal";
  if (suffix.startsWith("low")) return "low";
  if (suffix.startsWith("medium")) return "medium";
  if (suffix.startsWith("high") && !suffix.startsWith("xhigh")) return "high";
  if (suffix.startsWith("xhigh")) return "xhigh";
  if (suffix.startsWith("max")) return "max";
  if (suffix.includes("thinking")) return "high";
  return null;
}

function preferredDefault(map: ThinkingLevelMap): string | undefined {
  for (const level of ["high", "medium", "max", "xhigh", "low", "minimal", "off"] as const) {
    const value = map[level];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function familyToModels(family: DevinFamily): ProviderModelConfig[] {
  const usable = family.variants.filter((variant) => {
    const key = variantKey(variant.model_uid);
    return !key || (!key.includes("priority") && !key.includes("fast") && key !== "thinking-1m");
  });
  const source = usable.length > 0 ? usable : family.variants;
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const variant of source) {
    // Legacy MODEL_PRIVATE_* IDs carry no effort; use the CLI label too.
    const labelLevel = variant.label.match(/\b(none|off|minimal|low|medium|high|x-?high|max)\b(?:\s+(?:thinking|fast))?$/i)?.[1]?.toLowerCase().replace("x-high", "xhigh");
    const level = thinkingFromSuffix(labelLevel === "off" ? "none" : labelLevel ?? variantKey(variant.model_uid))
      ?? (/no thinking/i.test(variant.label) ? "off" : /thinking/i.test(variant.label) ? "high" : "off");
    if (level && thinkingLevelMap[level] === undefined) {
      thinkingLevelMap[level] = variant.model_uid;
    }
  }
  // pi treats a missing level as supported and only null hides it, so mark every
  // level this family does not ship. The picker then matches the real variants
  // instead of silently falling back to the default one.
  for (const level of THINKING_ORDER) {
    if (thinkingLevelMap[level] === undefined) thinkingLevelMap[level] = null;
  }

  const defaultUid = preferredDefault(thinkingLevelMap) ?? source[0]?.model_uid ?? family.family_uid;
  const sample = source.find((variant) => variant.model_uid === defaultUid) ?? source[0];
  if (!sample) return [];

  const mappedLevels = THINKING_ORDER.filter((level) => typeof thinkingLevelMap[level] === "string");
  const reasoning = mappedLevels.some((level) => level !== "off");

  // With a thinking map the pi-facing id never reaches the wire — resolveModelUid
  // always maps it — so keep the family id and let pi's thinking level choose the
  // variant, instead of baking "-high" into the model id.
  const familyId = family.slug || family.family_uid || defaultUid;

  return [
    {
      id: familyId,
      name: family.family_label || family.slug || defaultUid,
      reasoning,
      thinkingLevelMap,
      input: ["text", "image"],
      cost: parseCost(sample.cost_summary),
      contextWindow: sample.max_context_tokens ?? 256_000,
      maxTokens: sample.max_output_tokens ?? 128_000,
    },
  ];
}

// Only advertise models from a successfully loaded CLI catalog or its cache.
export const FALLBACK_MODELS: ProviderModelConfig[] = [];

export function modelsFromCatalog(catalog: DevinCatalog | null): ProviderModelConfig[] {
  return catalog?.families?.flatMap(familyToModels) ?? [];
}

export async function loadCliCatalog(): Promise<DevinCatalog | null> {
  const { stdout, code, stderr } = await runDevin(["models", "list", "--format", "json"], {
    timeoutMs: 20_000,
  });
  if (code !== 0) {
    throw new Error(stderr.trim() || `devin models list exited ${code}`);
  }
  const parsed = JSON.parse(stdout) as DevinCatalog;
  if (!parsed?.families) return null;
  return parsed;
}

export function resolveModelUid(
  modelId: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
  reasoning?: string,
): string {
  if (reasoning && thinkingLevelMap) {
    const mapped = thinkingLevelMap[reasoning as keyof ThinkingLevelMap];
    if (typeof mapped === "string") return mapped;
  }
  if (thinkingLevelMap) {
    const fallback = preferredDefault(thinkingLevelMap);
    if (fallback) return fallback;
  }
  return modelId;
}
