import { parentPort, workerData } from "node:worker_threads";
import { serve } from "srvx";
import { resolveEntry, parseServerAddress } from "../../common/worker-utils.ts";

const data = workerData || {};
const entry = await resolveEntry(data.entry);

const server = serve({
  port: 0,
  hostname: "127.0.0.1",
  silent: true,
  fetch: entry.fetch,
  middleware: entry.middleware,
  plugins: entry.plugins,
  gracefulShutdown: false,
});

await server.ready();

if (entry.ipc) {
  await entry.ipc.onOpen?.({
    sendMessage: (message) => parentPort?.postMessage(message),
  });
}

parentPort?.postMessage({
  address: parseServerAddress(server),
});

parentPort?.on("message", (message) => {
  if (message?.event === "shutdown") {
    Promise.resolve(entry.ipc?.onClose?.())
      .then(() => server.close())
      .then(() => {
        parentPort?.postMessage({ event: "exit" });
      });
    return;
  }

  if (message?.type === "ping") {
    parentPort?.postMessage({ type: "pong", data: message.data });
    return;
  }

  entry.ipc?.onMessage?.(message);
});
