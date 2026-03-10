import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData as MiniflareEnvRunnerData } from "../../common/base-runner.ts";

export interface MiniflareEnvRunnerOptions {
  name: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  /** Options passed directly to the Miniflare constructor. */
  miniflareOptions?: Record<string, unknown>;
}

const IPC_HEADER = "x-env-runner-ipc";

export class MiniflareEnvRunner extends BaseEnvRunner {
  #miniflare?: InstanceType<any>;
  #miniflareOptions: Record<string, unknown>;
  #reloadCounter = 0;

  constructor(opts: MiniflareEnvRunnerOptions) {
    super({ ...opts, workerEntry: "" });
    this.#miniflareOptions = opts.miniflareOptions || {};
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
    if (!this.#miniflare) {
      throw new Error("Miniflare env runner should be initialized before sending messages.");
    }
    // Handle ping/pong internally
    if ((message as any)?.type === "ping") {
      queueMicrotask(() => this._handleMessage({ type: "pong", data: (message as any).data }));
      return;
    }
    // Send message to worker via dispatchFetch with IPC header
    this.#miniflare
      .dispatchFetch("http://localhost/__env_runner_ipc", {
        method: "POST",
        headers: { [IPC_HEADER]: "message" },
        body: JSON.stringify(message),
      })
      .catch(() => {});
  }

  /**
   * Hot-reload the user entry module without recreating the Miniflare instance.
   *
   * Uses `unsafeEvalBinding` to dynamically re-import the entry module with a
   * cache-busting query string, served via `unsafeModuleFallbackService`.
   */
  override async reloadModule(): Promise<void> {
    if (!this.#miniflare) {
      throw new Error("Miniflare env runner should be initialized before reloading.");
    }
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath) {
      return;
    }
    this.#reloadCounter++;
    await this.#miniflare
      .dispatchFetch("http://localhost/__env_runner_ipc", {
        method: "POST",
        headers: { [IPC_HEADER]: "reload" },
        body: String(this.#reloadCounter),
      })
      .catch(() => {});
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
    // Notify worker of shutdown
    await this.#miniflare
      .dispatchFetch("http://localhost/__env_runner_ipc", {
        method: "POST",
        headers: { [IPC_HEADER]: "shutdown" },
      })
      .catch(() => {});
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

    // Inject IPC service binding (worker → runner outbound messages)
    const existingBindings = (options.serviceBindings as Record<string, unknown>) || {};
    options.serviceBindings = {
      ...existingBindings,
      __ENV_RUNNER_IPC: async (request: Request) => {
        const message = await request.json().catch(() => null);
        if (message !== null) {
          this._handleMessage(message);
        }
        return new Response(null, { status: 204 });
      },
    };

    // Generate in-memory wrapper module with IPC support
    if (entryPath && !options.script && !options.scriptPath) {
      const resolvedEntry = resolve(entryPath);
      const entryDir = dirname(resolvedEntry);

      options.script = generateWrapper(resolvedEntry);
      options.scriptPath = entryDir + "/__env_runner_wrapper.mjs";
      // Use "/" as modulesRoot so absolute paths don't produce ".." relative paths
      if (!options.modulesRoot) {
        options.modulesRoot = "/";
      }

      // Enable unsafeEval for hot-reload support (re-import entry without restart)
      options.unsafeEvalBinding = "__ENV_RUNNER_UNSAFE_EVAL__";

      // Module fallback: resolve imports that workerd can't find on its own
      // (e.g. imports from node_modules, parent dirs, cache-busted reload imports)
      if (!options.unsafeModuleFallbackService) {
        const _require = createRequire(resolvedEntry);
        options.unsafeUseModuleFallbackService = true;
        // Map workerd module names to real filesystem paths for correct
        // relative import resolution from bare-specifier modules.
        const modulePathMap = new Map<string, string>();
        options.unsafeModuleFallbackService = (request: Request) => {
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
          try {
            const contents = readFileSync(resolvedPath, "utf8");
            // workerd requires name to match specifier
            // Preserve query string in name for cache-busting (workerd caches by name)
            const rawQuery = specifier.includes("?") ? specifier.slice(specifier.indexOf("?")) : "";
            const name =
              (cleanSpecifier.startsWith("/") ? cleanSpecifier.slice(1) : cleanSpecifier) +
              rawQuery;
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

    // Trigger IPC init (calls onOpen in the worker)
    const initRes = await this.#miniflare.dispatchFetch("http://localhost/__env_runner_ipc", {
      method: "POST",
      headers: { [IPC_HEADER]: "init" },
    });
    if (initRes.status !== 204) {
      const body = await initRes.text().catch(() => "");
      console.error("[miniflare-runner] init failed:", initRes.status, body);
    }

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
 * The wrapper intercepts IPC requests and bridges `ipc` hooks
 * via `env.__ENV_RUNNER_IPC` service binding.
 *
 * Supports hot-reload via `unsafeEvalBinding`: the "reload" IPC message
 * uses dynamic `import()` with a cache-busting query string to re-import
 * the entry module (served fresh by `unsafeModuleFallbackService`).
 *
 * Passed as an in-memory `script` to Miniflare (no temp files needed).
 */
function generateWrapper(entryPath: string): string {
  return /* js */ `import __process from "node:process";
if (!globalThis.process) { globalThis.process = __process; }
export * from ${JSON.stringify(entryPath)};

const __IPC_HEADER = "${IPC_HEADER}";
const __entryPath = ${JSON.stringify(entryPath)};
let __userEntry;
let __ipcInitialized = false;
let __sendMessage;

async function __loadEntry(env, path) {
  const importFn = env.__ENV_RUNNER_UNSAFE_EVAL__.newAsyncFunction(
    "return await import(path)",
    "loadEntry",
    "path"
  );
  const mod = await importFn(path);
  return mod.default || mod;
}

export default {
  async fetch(request, env, ctx) {
    const ipcType = request.headers.get(__IPC_HEADER);
    if (ipcType) {
      if (ipcType === "init") {
        try {
          if (!__userEntry) {
            __userEntry = await __loadEntry(env, __entryPath);
          }
        } catch (e) {
          return new Response("Failed to load entry: " + String(e), { status: 500 });
        }
        if (!__ipcInitialized && __userEntry.ipc && env.__ENV_RUNNER_IPC) {
          __ipcInitialized = true;
          __sendMessage = (message) => {
            env.__ENV_RUNNER_IPC.fetch("http://ipc/", {
              method: "POST",
              body: JSON.stringify(message),
            });
          };
          if (__userEntry.ipc.onOpen) {
            await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
          }
        }
        return new Response(null, { status: 204 });
      }
      if (ipcType === "message") {
        const message = await request.json();
        if (__userEntry?.ipc?.onMessage) {
          __userEntry.ipc.onMessage(message);
        }
        return new Response(null, { status: 204 });
      }
      if (ipcType === "shutdown") {
        if (__userEntry?.ipc?.onClose) {
          await __userEntry.ipc.onClose();
        }
        return new Response(null, { status: 204 });
      }
      if (ipcType === "reload" && env.__ENV_RUNNER_UNSAFE_EVAL__) {
        const version = await request.text();
        try {
          const newEntry = await __loadEntry(env, __entryPath + "?t=" + version);
          if (__userEntry?.ipc?.onClose) {
            await __userEntry.ipc.onClose();
          }
          __userEntry = newEntry;
          __ipcInitialized = false;
          if (__userEntry.ipc?.onOpen && __sendMessage) {
            __ipcInitialized = true;
            await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
          }
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 400 });
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
