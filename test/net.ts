// HTTP for the server tests, with or without TCP ports.
//
// Some sandboxes (e.g. Codex's workspace-write) forbid binding any TCP port: listen() fails with EPERM. There the
// servers are driven in-process instead: each request gets its own in-memory socket pair, handed to the real
// http.Server through its "connection" event, so the same request handlers and HTTP parsing run without a port.
// Set SIEGE_TEST_INPROCESS=1 to force that path where ports work.
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { Readable, duplexPair } from "node:stream";

export const canListen: boolean =
  process.env.SIEGE_TEST_INPROCESS === "1"
    ? false
    : await new Promise<boolean>((res) => {
        const s = net.createServer();
        s.once("error", () => res(false));
        s.listen(0, "127.0.0.1", () => s.close(() => res(true)));
      });
if (!canListen) console.warn("NOTE: sandbox forbids listening on TCP ports; server tests run over in-process sockets instead");

export interface Served {
  base: string;
  fetch: typeof fetch;
  /** GET with a chosen Host header (fetch() sets Host itself). */
  getWithHost(path: string, host: string): Promise<string>;
  close(): Promise<void>;
}

export async function serve(server: http.Server): Promise<Served> {
  if (canListen) {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
      base: `http://127.0.0.1:${port}`,
      fetch: globalThis.fetch,
      getWithHost: (p, host) => request({ host: "127.0.0.1", port, path: p, headers: { host } }),
      close: () => close(server),
    };
  }
  // An in-memory pair does not pass a destroy across, so both ends are closed together.
  const open = new Set<() => void>();
  const connect = () => {
    const [client, srv] = duplexPair();
    const end = () => {
      client.destroy();
      srv.destroy();
      open.delete(end);
    };
    open.add(end);
    client.once("close", end);
    server.emit("connection", srv);
    return client as unknown as net.Socket;
  };
  const inproc = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body == null ? undefined : typeof init.body === "string" ? init.body : Buffer.from(await new Response(init.body).arrayBuffer());
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const req = http.request({ path: u.pathname + u.search, method: init.method ?? "GET", headers: { host: u.host, ...headers }, createConnection: connect }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        const nullBody = res.statusCode === 204 || res.statusCode === 304 || init.method === "HEAD";
        resolve(new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream), { status: res.statusCode, headers: h }));
      });
      init.signal?.addEventListener("abort", () => req.destroy(new DOMException("aborted", "AbortError")));
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;
  return {
    base: "http://in-process.test",
    fetch: inproc,
    getWithHost: (p, host) => request({ path: p, headers: { host }, createConnection: connect }),
    close: async () => [...open].forEach((end) => end()),
  };
}

function request(opts: http.RequestOptions) {
  return new Promise<string>((resolve, reject) => {
    http.get(opts, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(t));
    }).on("error", reject);
  });
}

function close(server: http.Server) {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
}
