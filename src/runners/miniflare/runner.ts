import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData as MiniflareEnvRunnerData } from "../../common/base-runner.ts";

/** Result from a module transform (compatible with Vite's `TransformResult`). */
export interface TransformResult {
  code: string;
}

export interface MiniflareEnvRunnerOptions {
  name: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  /** Options passed directly to the Miniflare constructor. */
  miniflareOptions?: Record<string, unknown>;
  /**
   * Optional module transform callback. When provided, the module fallback
   * service calls this instead of reading raw files from disk.
   *
   * This enables integration with Vite's transform pipeline — pass
   * `environment.transformRequest` to get TS/JSX/etc. compiled on the fly.
   *
   * @param id - Absolute file path of the module to transform
   * @returns Transformed code, or null/undefined to fall back to raw disk read
   */
  transformRequest?: (id: string) => Promise<TransformResult | null | undefined>;
}

const IPC_PATH = "/__env_runner_ipc";

export class MiniflareEnvRunner extends BaseEnvRunner {
  #miniflare?: InstanceType<any>;
  #miniflareOptions: Record<string, unknown>;
  #transformRequest?: (id: string) => Promise<TransformResult | null | undefined>;
  #reloadCounter = 0;
  #ws?: { send(data: string): void; close(): void };

  constructor(opts: MiniflareEnvRunnerOptions) {
    super({ ...opts, workerEntry: "" });
    this.#miniflareOptions = opts.miniflareOptions || {};
    this.#transformRequest = opts.transformRequest;
    this.#init();
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!this.#miniflare || this.closed) {
      return new Response("miniflare env runner is unavailable", { status: 503 });
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return this.#miniflare.dispatchFetch(url, init) as Promise<Response>;
  }

  sendMessage(message: unknown) {
    if (!this.#ws) {
      throw new Error("Miniflare env runner should be initialized before sending messages.");
    }
    // Handle ping/pong internally
    if ((message as any)?.type === "ping") {
      queueMicrotask(() => this._handleMessage({ type: "pong", data: (message as any).data }));
      return;
    }
    this.#ws.send(JSON.stringify({ type: "message", data: message }));
  }

  /**
   * Hot-reload the user entry module without recreating the Miniflare instance.
   *
   * Sends `reload-module` event over the WebSocket. The worker wrapper uses
   * `unsafeEvalBinding` to re-import the entry with a cache-busting query string
   * and responds with `module-reloaded` when done.
   */
  override async reloadModule(timeout = 5000): Promise<void> {
    if (!this.#ws) {
      throw new Error("Miniflare env runner should be initialized before reloading.");
    }
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath) {
      return;
    }
    this.#reloadCounter++;
    const version = this.#reloadCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Module reload timed out"));
      }, timeout);
      const listener = (msg: any) => {
        if (msg?.event === "module-reloaded") {
          cleanup();
          if (msg.error) {
            reject(typeof msg.error === "string" ? new Error(msg.error) : msg.error);
          } else {
            resolve();
          }
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.offMessage(listener);
      };
      this.onMessage(listener);
      this.#ws!.send(JSON.stringify({ type: "reload", version }));
    });
  }

  // #region Protected methods

  protected _hasRuntime() {
    return Boolean(this.#miniflare);
  }

  protected _runtimeType() {
    return "miniflare";
  }

  protected async _closeRuntime() {
    if (!this.#miniflare) {
      return;
    }
    if (this.#ws) {
      this.#ws.send(JSON.stringify({ type: "shutdown" }));
      this.#ws.close();
      this.#ws = undefined;
    }
    await this.#miniflare.dispose();
    this.#miniflare = undefined;
  }

  // #endregion

  // #region Private methods

  #init() {
    this.#initAsync().catch((error) => {
      console.error("Miniflare runner init error:", error);
      this.close(error);
    });
  }

  async #initAsync() {
    const { Miniflare } = await import("miniflare");

    const entryPath = this._data?.entry as string | undefined;

    const userFlags = (this.#miniflareOptions.compatibilityFlags as string[]) || [];
    const options: Record<string, unknown> = {
      compatibilityDate: new Date().toISOString().split("T")[0],
      modules: true,
      ...this.#miniflareOptions,
      compatibilityFlags: [...new Set(["nodejs_compat", ...userFlags])],
    };

    // Generate in-memory wrapper module with IPC support
    if (entryPath && !options.script && !options.scriptPath) {
      const resolvedEntry = resolve(entryPath);
      const entryDir = dirname(resolvedEntry);

      options.script = generateWrapper(resolvedEntry, { dynamicOnly: Boolean(this.#transformRequest) });
      options.scriptPath = entryDir + "/__env_runner_wrapper.mjs";
      // Use "/" as modulesRoot so absolute paths don't produce ".." relative paths
      if (!options.modulesRoot) {
        options.modulesRoot = "/";
      }

      // Enable unsafeEval for hot-reload support (re-import entry without restart)
      options.unsafeEvalBinding = "__ENV_RUNNER_UNSAFE_EVAL__";

      // When transformRequest is provided, add module rules so miniflare's
      // ModuleLocator doesn't reject non-JS extensions (e.g. .ts, .tsx, .jsx)
      if (this.#transformRequest && !options.modulesRules) {
        options.modulesRules = [
          { type: "ESModule", include: ["**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mts"] },
        ];
      }

      // Module fallback: resolve imports that workerd can't find on its own
      // (e.g. imports from node_modules, parent dirs, cache-busted reload imports)
      if (!options.unsafeModuleFallbackService) {
        const _require = createRequire(resolvedEntry);
        const _transformRequest = this.#transformRequest;
        options.unsafeUseModuleFallbackService = true;
        // Map workerd module names to real filesystem paths for correct
        // relative import resolution from bare-specifier modules.
        const modulePathMap = new Map<string, string>();
        options.unsafeModuleFallbackService = async (request: Request) => {
          const url = new URL(request.url);
          const specifier = url.searchParams.get("specifier");
          const rawSpecifier = url.searchParams.get("rawSpecifier");
          const referrer = url.searchParams.get("referrer") || "";
          if (!specifier) {
            return new Response(null, { status: 404 });
          }
          const cleanSpecifier = specifier.split("?")[0] || specifier;
          const cleanRaw = rawSpecifier?.split("?")[0];
          let resolvedPath: string;

          // Bare specifier (npm package) — resolve via Node module resolution
          if (cleanRaw && !cleanRaw.startsWith(".") && !cleanRaw.startsWith("/")) {
            // For node:* builtins not natively supported by workerd, use unenv polyfill
            if (cleanRaw.startsWith("node:")) {
              const nodeName = cleanRaw.slice(5);
              try {
                resolvedPath = _require.resolve(`unenv/node/${nodeName}`);
              } catch {
                return new Response(null, { status: 404 });
              }
            } else {
              try {
                resolvedPath = _require.resolve(cleanRaw);
              } catch {
                return new Response(null, { status: 404 });
              }
            }
          } else {
            // Resolve against the referrer's real filesystem path
            const referrerKey = referrer.startsWith("/") ? referrer.slice(1) : referrer;
            const referrerReal =
              modulePathMap.get(referrerKey) ||
              (referrer.startsWith("/") ? referrer : "/" + referrer);
            const referrerDir = dirname(referrerReal);
            const raw = cleanRaw || cleanSpecifier;
            if (raw.startsWith(".")) {
              resolvedPath = resolve(referrerDir, raw);
            } else if (cleanSpecifier.startsWith("/")) {
              // Absolute specifier — use directly
              resolvedPath = cleanSpecifier;
            } else {
              try {
                resolvedPath = _require.resolve(raw);
              } catch {
                return new Response(null, { status: 404 });
              }
            }
          }

          // workerd requires name to match specifier
          // Preserve query string in name for cache-busting (workerd caches by name)
          const rawQuery = specifier.includes("?") ? specifier.slice(specifier.indexOf("?")) : "";
          const name =
            (cleanSpecifier.startsWith("/") ? cleanSpecifier.slice(1) : cleanSpecifier) + rawQuery;

          // Try Vite transform pipeline first (TS/JSX → JS, etc.)
          if (_transformRequest) {
            try {
              const result = await _transformRequest(resolvedPath);
              if (result?.code) {
                modulePathMap.set(name, resolvedPath);
                return Response.json({ name, esModule: result.code });
              }
            } catch {
              // Fall through to raw disk read
            }
          }

          try {
            const contents = readFileSync(resolvedPath, "utf8");
            // Track the real path so relative imports from this module resolve correctly
            modulePathMap.set(name, resolvedPath);
            // Detect module type: .mjs is always ESM, .cjs is always CJS,
            // otherwise check for ESM syntax indicators
            const isESM =
              resolvedPath.endsWith(".mjs") ||
              (!resolvedPath.endsWith(".cjs") &&
                /\b(import\s|import\(|export\s|export\{|import\.meta\b)/.test(contents));
            return Response.json({
              name,
              ...(isESM ? { esModule: contents } : { commonJsModule: contents }),
            });
          } catch {
            return new Response(null, { status: 404 });
          }
        };
      }
    }

    this.#miniflare = new Miniflare(options);

    await this.#miniflare.ready;

    // Establish persistent WebSocket connection for IPC
    const initRes = await this.#miniflare.dispatchFetch("http://localhost" + IPC_PATH, {
      headers: { upgrade: "websocket" },
    });
    const ws = initRes.webSocket;
    if (!ws) {
      throw new Error("Failed to establish WebSocket IPC channel");
    }
    ws.accept();
    this.#ws = ws;

    // Listen for messages from the worker
    ws.addEventListener("message", (event: { data: string }) => {
      try {
        const parsed = JSON.parse(event.data);
        this._handleMessage(parsed);
      } catch {
        // Ignore malformed messages
      }
    });

    // Signal ready with a dummy address (fetch is overridden)
    this._handleMessage({ address: { host: "127.0.0.1", port: 0 } });
  }

  // #endregion
}

// #region Helpers

/**
 * Generates a wrapper module that imports the user entry and adds IPC glue.
 *
 * The user module is expected to export `fetch` and optionally `ipc`.
 * The wrapper uses a persistent WebSocket pair for bidirectional IPC:
 * - Init: `fetch` with `upgrade: websocket` creates a WebSocketPair
 * - Messages: JSON over the WebSocket (no per-message `dispatchFetch`)
 * - Reload: `{ type: "reload" }` triggers cache-busted re-import
 * - Shutdown: `{ type: "shutdown" }` calls `ipc.onClose()`
 *
 * Passed as an in-memory `script` to Miniflare (no temp files needed).
 */
function generateWrapper(
  entryPath: string,
  opts?: { dynamicOnly?: boolean },
): string {
  // When dynamicOnly is set, skip static `export *` to avoid miniflare's
  // ModuleLocator walking the entry's import tree at startup. All module
  // loading goes through dynamic import() via unsafeEvalBinding instead.
  const staticReExport = opts?.dynamicOnly ? "" : `export * from ${JSON.stringify(entryPath)};`;
  return /* js */ `import __process from "node:process";
if (!globalThis.process) { globalThis.process = __process; }
${staticReExport}

const __IPC_PATH = "${IPC_PATH}";
const __entryPath = ${JSON.stringify(entryPath)};
let __userEntry;
let __ipcInitialized = false;
let __serverWs;

async function __loadEntry(env, path) {
  const importFn = env.__ENV_RUNNER_UNSAFE_EVAL__.newAsyncFunction(
    "return await import(path)",
    "loadEntry",
    "path"
  );
  const mod = await importFn(path);
  return mod.default || mod;
}

function __sendMessage(message) {
  if (__serverWs) {
    __serverWs.send(JSON.stringify(message));
  }
}

async function __handleWsMessage(env, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  if (msg.type === "message") {
    if (__userEntry?.ipc?.onMessage) {
      __userEntry.ipc.onMessage(msg.data);
    }
    return;
  }

  if (msg.type === "reload" && env.__ENV_RUNNER_UNSAFE_EVAL__) {
    const version = msg.version || 0;
    try {
      const newEntry = await __loadEntry(env, __entryPath + "?t=" + version);
      if (__userEntry?.ipc?.onClose) {
        await __userEntry.ipc.onClose();
      }
      __userEntry = newEntry;
      __ipcInitialized = false;
      if (__userEntry.ipc?.onOpen) {
        __ipcInitialized = true;
        await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
      }
      __sendMessage({ event: "module-reloaded" });
    } catch (e) {
      __sendMessage({ event: "module-reloaded", error: String(e) });
    }
    return;
  }

  if (msg.type === "shutdown") {
    if (__userEntry?.ipc?.onClose) {
      await __userEntry.ipc.onClose();
    }
    return;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket IPC handshake
    if (url.pathname === __IPC_PATH && request.headers.get("upgrade") === "websocket") {
      try {
        if (!__userEntry) {
          __userEntry = await __loadEntry(env, __entryPath);
        }
      } catch (e) {
        return new Response("Failed to load entry: " + String(e), { status: 500 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      __serverWs = server;

      server.addEventListener("message", (event) => {
        __handleWsMessage(env, event.data);
      });

      // Initialize IPC hooks
      if (!__ipcInitialized && __userEntry.ipc) {
        __ipcInitialized = true;
        if (__userEntry.ipc.onOpen) {
          await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
        }
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (!__userEntry) {
      return new Response("Worker not initialized", { status: 503 });
    }
    const entryFetch = __userEntry.fetch;
    if (!entryFetch) {
      return new Response("No fetch handler exported", { status: 500 });
    }
    return entryFetch(request, env, ctx);
  }
};
`;
}

// #endregion
