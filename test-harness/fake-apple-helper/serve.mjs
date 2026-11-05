// Puts a FakeHelper on a unix socket so the native host (host.mjs, started by the browser) can reach it.
// The test process owns the helper, so the vault and the code on screen outlive each host process.
// One JSON object per line: host -> {msg}, helper -> {reply}.

import { createServer } from "node:net";
import { rm } from "node:fs/promises";

export async function serveHelper(helper, sockPath) {
  await rm(sockPath, { force: true });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    const link = helper.connect((reply) => {
      if (!socket.destroyed) socket.write(JSON.stringify({ reply }) + "\n");
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) void link.receive(JSON.parse(line).msg);
      }
    });
    const done = () => {
      sockets.delete(socket);
      link.close();
    };
    socket.on("close", done);
    socket.on("error", done);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(sockPath, resolve));
  return {
    sockPath,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      await rm(sockPath, { force: true });
    },
  };
}
