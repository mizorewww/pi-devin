import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function candidateBins(): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local");
  return [
    // Explicit override always wins. Read lazily so a value set after module
    // load (e.g. by the host process) is still honoured.
    process.env.DEVIN_CLI,
    ...(process.platform === "win32" ? [
    // Official installer location (%LOCALAPPDATA%\devin\cli\bin\devin.exe)
    join(localAppData, "devin/cli/bin/devin.exe"),
    // Devin Desktop (Windsurf-based) bundled CLI, per-user install
    join(localAppData, "Programs/Devin/resources/app/extensions/windsurf/devin/bin/devin.exe"),
    // Devin Desktop bundled CLI, machine-wide install
    process.env.ProgramFiles &&
      join(process.env.ProgramFiles, "Devin/resources/app/extensions/windsurf/devin/bin/devin.exe"),
    // Set by the official Windows installer when it completes normally.
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "devin/bin/devin.exe"),
    // Manual fallback for installs that could not finish while Devin was running.
    join(homedir(), ".devin-cli/devin.exe"),
    ] : [
    join(homedir(), ".local/bin/devin"),
    join(homedir(), ".devin/bin/devin"),
    "/opt/homebrew/bin/devin",
    "/usr/local/bin/devin",
    "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin",
    ]),
  ].filter((p): p is string => Boolean(p));
}

let cachedBin: string | null | undefined;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findDevinBin(): string | null {
  // An explicit override must take effect even after a successful discovery.
  if (process.env.DEVIN_CLI && isFile(process.env.DEVIN_CLI)) return process.env.DEVIN_CLI;
  if (cachedBin !== undefined) return cachedBin;
  for (const bin of candidateBins()) {
    if (isFile(bin)) {
      cachedBin = bin;
      return bin;
    }
  }
  cachedBin = null;
  return null;
}

export function clearDevinBinCache(): void {
  cachedBin = undefined;
}

export async function whichDevin(): Promise<string | null> {
  const known = findDevinBin();
  if (known) return known;
  // Windows has no `which`; use `where` and probe the returned paths directly.
  const isWindows = process.platform === "win32";
  const locator = isWindows ? "where.exe" : "/usr/bin/which";
  const candidates = isWindows ? ["devin.exe", "devin.cmd", "devin"] : ["devin"];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(locator, [candidate], { timeout: 5_000 });
      // `where` may return several lines; take the first existing one.
      for (const line of stdout.split(/\r?\n/)) {
        const path = line.trim();
        if (path && isFile(path)) {
          cachedBin = path;
          return path;
        }
      }
    } catch {
      // not on PATH
    }
  }
  return null;
}

export async function runDevin(
  args: string[],
  opts: { timeoutMs?: number; inheritStdio?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = await whichDevin();
  if (!bin) {
    throw new Error(
      "Devin CLI not found. Install the Devin CLI, or set DEVIN_CLI to the `devin` binary.",
    );
  }

  // Batch wrappers need cmd.exe. Quote paths with spaces, and reject shell
  // expansion characters rather than interpreting them as part of a command.
  const wrapper = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  if (wrapper && [bin, ...args].some((part) => /["%!\r\n]/.test(part))) {
    throw new Error("Unsupported shell characters in Devin wrapper path or arguments. Set DEVIN_CLI to devin.exe.");
  }
  const executable = wrapper ? process.env.ComSpec || "cmd.exe" : bin;
  const commandArgs = wrapper ? ["/d", "/s", "/c", `"${[bin, ...args].map((part) => `"${part}"`).join(" ")}"`] : args;

  if (opts.inheritStdio) {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, commandArgs, { stdio: "inherit", windowsVerbatimArguments: wrapper });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ stdout: "", stderr: "", code: code ?? 1 });
      });
    });
  }

  try {
    const { stdout, stderr } = await execFileAsync(executable, commandArgs, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsVerbatimArguments: wrapper,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (typeof err.code === "number") {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
    }
    throw error;
  }
}

export async function devinVersion(): Promise<string | null> {
  try {
    const { stdout, code } = await runDevin(["version"], { timeoutMs: 8_000 });
    if (code !== 0) return null;
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
