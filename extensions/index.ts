import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { authStatus, ensureCredentials, loginWithCli, readCredentials } from "../src/credentials.js";
import { readDevinDesktopApiKey } from "../src/desktop-auth.js";
import { whichDevin, devinVersion } from "../src/cli.js";
import {
  type CachedDevinCatalog,
  isUsableCatalog,
  isCatalogCacheFresh,
  readCatalogCache,
  writeCatalogCache,
} from "../src/catalog-cache.js";
import { FALLBACK_MODELS, loadCliCatalog, modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";

const PROVIDER_ID = "devin";
const PLACEHOLDER_BASE_URL = "https://server.codeium.com";

let _pi: ExtensionAPI | null = null;
let catalogRequest: Promise<ProviderModelConfig[]> | null = null;

function isOffline(): boolean {
  const value = process.env.PI_OFFLINE?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function refreshCatalog(pi: ExtensionAPI): Promise<ProviderModelConfig[]> {
  if (!catalogRequest) {
    const pending = loadCliCatalog().then((catalog) => {
      if (!isUsableCatalog(catalog)) {
        throw new Error("Devin CLI returned no usable model families");
      }
      const models = modelsFromCatalog(catalog);
      try {
        writeCatalogCache(catalog);
      } catch (error) {
        console.warn(`Devin: failed to cache model catalog: ${error instanceof Error ? error.message : String(error)}`);
      }
      return models;
    });
    catalogRequest = pending;
    void pending.finally(() => {
      if (catalogRequest === pending) catalogRequest = null;
    }).catch(() => {});
  }
  return catalogRequest.then((models) => {
    if (_pi === pi) registerDevinProvider(pi, models);
    return models;
  });
}

function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin Local",
    api: "devin-local",
    baseUrl: PLACEHOLDER_BASE_URL,
    models,
    oauth: {
      name: "Devin CLI",
      async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const creds = await loginWithCli();
        if (_pi) {
          try {
            await refreshCatalog(_pi);
          } catch {
            // keep current models
          }
        }
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const creds = readCredentials();
        if (!creds) return credentials;
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return readCredentials()?.apiKey || credentials.access;
      },
      modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
        return models;
      },
    },
    streamSimple: streamDevin,
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  _pi = pi;
  let cached: CachedDevinCatalog | null | undefined;
  let initialModels = FALLBACK_MODELS;
  try {
    cached = readCatalogCache();
    if (cached) initialModels = modelsFromCatalog(cached.catalog);
  } catch (error) {
    cached = null;
    console.warn(`Devin: failed to read model catalog cache: ${error instanceof Error ? error.message : String(error)}`);
  }
  registerDevinProvider(pi, initialModels);

  if (!isOffline()) {
    try {
      if (await ensureCredentials()) {
        if (!cached) {
          await refreshCatalog(pi);
        } else if (!isCatalogCacheFresh(cached)) {
          void refreshCatalog(pi).catch((error) => {
            console.warn(`Devin: background model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
    } catch {
      // Cached or fallback models stay registered when credential discovery or a cold refresh fails.
    }
  }

  pi.registerCommand("devin-status", {
    description: "Show Devin CLI auth + binary status",
    handler: async (_args, ctx) => {
      const bin = await whichDevin();
      const version = await devinVersion();
      const status = await authStatus();
      const creds = readCredentials();
      const desktop = creds ? null : await readDevinDesktopApiKey();
      ctx.ui.notify(
        [
          bin ? `CLI: ${bin}` : "CLI: not found",
          version ? `CLI version: ${version}` : "CLI version: unknown",
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
          creds
            ? `Credentials: ${creds.path}`
            : desktop
              ? `Credentials: none stored yet; Devin Desktop sign-in found at ${desktop.source}`
              : "Credentials: none found (no CLI store, no Devin Desktop sign-in)",
          status.loggedIn ? "Auth: signed in via Devin CLI" : "Auth: not signed in. Run /login devin or `devin auth login`",
        ].join("\n"),
        status.loggedIn && bin ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Refresh Devin Local model catalog from `devin models list`",
    handler: async (_args, ctx) => {
      try {
        const models = await refreshCatalog(pi);
        ctx.ui.notify(`Devin: loaded ${models.length} families from the local CLI.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    if (_pi === pi) _pi = null;
  });
}
