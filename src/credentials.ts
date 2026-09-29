import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runDevin } from "./cli.js";
import { readDevinDesktopApiKey } from "./desktop-auth.js";

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
  webappHost: string;
  apiUrl: string;
  path: string;
}

const CREDENTIALS_PATH = join(homedir(), ".local/share/devin/credentials.toml");

function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function writeCredentials(apiKey: string): DevinCredentials {
  const body = [
    `windsurf_api_key = ${JSON.stringify(apiKey)}`,
    `api_server_url = "https://server.codeium.com"`,
    `devin_webapp_host = "app.devin.ai"`,
    `devin_api_url = "https://api.devin.ai"`,
    "",
  ].join("\n");
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, body, { mode: 0o600 });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // best effort on platforms without POSIX modes
  }
  const creds = readCredentials();
  if (!creds) throw new Error(`Wrote ${CREDENTIALS_PATH} but could not read it back.`);
  return creds;
}

/**
 * Seed the CLI store from a signed-in Devin Desktop.
 * Only fills the gap: an existing CLI store is never overwritten.
 */
export async function importFromDevinDesktop(): Promise<DevinCredentials | null> {
  if (existsSync(CREDENTIALS_PATH)) return null;
  const desktop = await readDevinDesktopApiKey();
  if (!desktop) return null;
  return writeCredentials(desktop.apiKey);
}

/** CLI store first, Devin Desktop second. */
export async function ensureCredentials(): Promise<DevinCredentials | null> {
  return readCredentials() ?? (await importFromDevinDesktop());
}

export function readCredentials(): DevinCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  const raw = parseTomlStrings(readFileSync(CREDENTIALS_PATH, "utf8"));
  const apiKey = raw.windsurf_api_key || raw.api_key;
  if (!apiKey) return null;
  return {
    apiKey,
    apiServerUrl: (raw.api_server_url || "https://server.codeium.com").replace(/\/$/, ""),
    webappHost: raw.devin_webapp_host || "app.devin.ai",
    apiUrl: raw.devin_api_url || "https://api.devin.ai",
    path: CREDENTIALS_PATH,
  };
}

export async function authStatus(): Promise<{
  loggedIn: boolean;
  summary: string;
}> {
  const creds = readCredentials();
  try {
    const { stdout, stderr, code } = await runDevin(["auth", "status"], { timeoutMs: 15_000 });
    const text = `${stdout}\n${stderr}`.trim();
    const loggedIn = code === 0 && /\blogged in\b/i.test(text) && !/\bnot logged in\b/i.test(text);
    return { loggedIn, summary: text || (creds ? "credentials.toml present" : "not signed in") };
  } catch (error) {
    if (creds) {
      return { loggedIn: true, summary: `Devin credentials present at ${CREDENTIALS_PATH}` };
    }
    return {
      loggedIn: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loginWithCli(): Promise<DevinCredentials> {
  const already = readCredentials();
  const status = await authStatus();
  if (already && status.loggedIn) return already;

  // A signed-in Devin Desktop already holds a usable session token. Reuse it
  // instead of sending the user through a browser round-trip for nothing.
  const imported = await importFromDevinDesktop();
  if (imported) return imported;

  const { code } = await runDevin(["auth", "login"], { inheritStdio: true });
  const creds = readCredentials();
  if (!creds) {
    throw new Error(
      `\`devin auth login\` ${code === 0 ? "finished" : `exited ${code}`} but ${CREDENTIALS_PATH} is missing. Run \`devin auth login\` yourself, then /login devin again.`,
    );
  }
  return creds;
}
