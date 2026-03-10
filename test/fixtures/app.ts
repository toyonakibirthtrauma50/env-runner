import type { AppEntry } from "../../src/common/worker-utils.ts";
import { runtime } from "std-env";

let sendMessage: ((message: unknown) => void) | undefined;

export default {
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/env") {
      return Response.json({
        runtime,
      });
    }

    if (url.pathname === "/echo") {
      return request.text().then((body) => {
        return Response.json({ body, method: request.method });
      });
    }

    return new Response("ok");
  },
  ipc: {
    onOpen(ctx) {
      sendMessage = ctx.sendMessage;
      sendMessage({ type: "ipc:opened" });
    },
    onMessage(message: any) {
      if (message?.type === "echo") {
        sendMessage?.({ type: "echo-reply", data: message.data });
      }
    },
    onClose() {
      sendMessage = undefined;
    },
  },
} satisfies AppEntry;
