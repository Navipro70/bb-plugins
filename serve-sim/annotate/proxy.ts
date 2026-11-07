// A local reverse proxy in front of serve-sim's preview. It passes every
// request, stream, and WebSocket through unchanged, except that the preview
// page gets the Annotate script (inject.ts), which adds a button to
// serve-sim's own toolbar and reports where the device's screen is drawn.
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { INJECT_PATH, injectScript } from "./inject";

export interface Proxy {
  url: string;
  close(): Promise<void>;
}

/** Response types small enough to buffer and rewrite. Streams pass through. */
const REWRITE = /^(text\/html|application\/json)/;

export async function startProxy(target: string): Promise<Proxy> {
  const upstream = new URL(target);
  const port = Number(upstream.port) || 80;
  let self = "";
  // serve-sim refuses cross-origin WebSockets and checks Origin against its
  // own host; requests through the proxy speak for serve-sim's origin.
  const origin = `${upstream.protocol}//${upstream.host}`;
  const asUpstream = (name: string, value: string | undefined) => {
    const lower = name.toLowerCase();
    if (lower === "host") return upstream.host;
    if ((lower === "origin" || lower === "referer") && value)
      return value.replace(`http://${self}`, origin);
    return value;
  };
  // serve-sim writes absolute URLs to itself into the page and its JSON;
  // they must point at the proxy, or the page's fetches turn cross-origin.
  const rewrite = (text: string) =>
    text
      .replaceAll(`//${upstream.host}`, `//${self}`)
      .replaceAll(`//127.0.0.1:${port}`, `//${self}`);

  const server: Server = createServer((req, res) => {
    if (req.url === INJECT_PATH) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(injectScript);
      return;
    }
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(req.headers))
      headers[name] = typeof value === "string" ? asUpstream(name, value) : value;
    // Uncompressed bodies, so HTML and JSON can be rewritten.
    delete headers["accept-encoding"];
    const out = httpRequest(
      { host: upstream.hostname, port, method: req.method, path: req.url, headers },
      (up: IncomingMessage) => {
        const type = String(up.headers["content-type"] ?? "");
        if (!REWRITE.test(type)) {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on("data", (chunk: Buffer) => chunks.push(chunk));
        up.on("end", () => {
          let body = rewrite(Buffer.concat(chunks).toString("utf8"));
          if (type.startsWith("text/html") && body.includes("__SIM_PREVIEW__"))
            body = body.replace("</body>", `<script src="${INJECT_PATH}"></script></body>`);
          const outHeaders = { ...up.headers };
          delete outHeaders["content-length"];
          delete outHeaders["content-encoding"];
          res.writeHead(up.statusCode ?? 502, outHeaders);
          res.end(body);
        });
        up.on("error", () => res.destroy());
      },
    );
    out.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });

  // WebSockets: replay the upgrade request to serve-sim and splice the sockets.
  server.on("upgrade", (req, socket, head) => {
    const up = connect(port, upstream.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        lines.push(`${name}: ${asUpstream(name, req.rawHeaders[i + 1])}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", end);
    socket.on("error", end);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  self = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `http://${self}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
