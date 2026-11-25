import { createServer } from "node:http";

export function createApp() {
  return createServer((_req, res) => {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not implemented" }));
  });
}
