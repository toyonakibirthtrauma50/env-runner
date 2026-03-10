import type { ServerOptions, Server } from "srvx";

export interface AppEntryIPCContext {
  sendMessage: (message: unknown) => void;
}

export interface AppEntryIPC {
  onOpen?: (ctx: AppEntryIPCContext) => void | Promise<void>;
  onMessage?: (message: unknown) => void | Promise<void>;
  onClose?: () => void | Promise<void>;
}

export interface AppEntry {
  fetch: ServerOptions["fetch"];
  middleware?: ServerOptions["middleware"];
  plugins?: ServerOptions["plugins"];
  ipc?: AppEntryIPC;
}

export async function resolveEntry(entryPath: string): Promise<AppEntry> {
  const mod = await import(entryPath);
  const entry = mod.default || mod;
  if (typeof entry.fetch !== "function") {
    throw new Error(
      `[env-runner] Entry module "${entryPath}" must export a \`fetch\` handler (export default { fetch(req) { ... } }).`,
    );
  }
  return entry as AppEntry;
}

export function parseServerAddress(server: Server): { host: string; port: number } {
  const url = new URL(server.url!);
  return { host: url.hostname, port: Number(url.port) };
}
