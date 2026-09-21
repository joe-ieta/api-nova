"use strict";
// SEC-E0-01: current SDK wire contract. B3 covers identity/revocation; STDIO suite covers child framing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  LATEST_PROTOCOL_VERSION,
} = require("@modelcontextprotocol/sdk/types.js");
const parser = require("api-nova-parser");
const {
  startStreamableMcpServer,
} = require("../dist/transportUtils/stream.js");
const { startSseMcpServer } = require("../dist/transportUtils/sse.js");
const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "adapter-contract", version: "1" },
  },
};
const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const frame = (text) =>
  JSON.parse(
    text
      .split("\n")
      .find((line) => line.startsWith("data: {"))
      .slice(6),
  );
for (const protocol of ["streamable", "sse"])
  test(
    protocol + ": raw HTTP adapter contract",
    { timeout: 30000 },
    async (t) => {
      const saved = { ...process.env },
        signals = Object.fromEntries(
          ["SIGINT", "SIGTERM"].map((name) => [name, process.listeners(name)]),
        );
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "api-nova-adapter-contract-"),
      );
      for (const key of Object.keys(process.env))
        if (
          key.startsWith("API_NOVA_RUNTIME_") ||
          key === "API_NOVA_TEMPORARY_ANONYMOUS"
        )
          delete process.env[key];
      Object.assign(process.env, {
        API_NOVA_RUNTIME_AUTH_MODE: "anonymous",
        API_NOVA_AUDIT_DIR: root,
      });
      let listener, reader;
      t.after(async () => {
        await reader?.cancel();
        listener?.closeAllConnections();
        if (listener) await new Promise((resolve) => listener.close(resolve));
        await parser.flushRuntimeAudit();
        for (const [name, previous] of Object.entries(signals))
          for (const handler of process.listeners(name))
            if (!previous.includes(handler)) process.off(name, handler);
        process.env = saved;
        assert.equal(path.dirname(root), os.tmpdir());
        assert.ok(path.basename(root).startsWith("api-nova-adapter-contract-"));
        await fs.rm(root, { recursive: true, force: true });
      });
      listener = await (
        protocol === "streamable" ? startStreamableMcpServer : startSseMcpServer
      )(
        async () => {
          const server = new McpServer({
            name: "adapter-contract",
            version: "1",
          });
          server.registerTool("echo", {}, async () => ({ content: [] }));
          return server;
        },
        "/mcp",
        0,
        { host: "127.0.0.1", allowedOrigins: ["http://localhost:9000"] },
      );
      if (!listener.listening) await once(listener, "listening");
      const base = `http://127.0.0.1:${listener.address().port}`;
      const request = (method, route = "/mcp", body, extra = {}) =>
        fetch(base + route, {
          method,
          headers: { ...headers, ...extra },
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
      const check = async (label, method, route, body, extra, status, code) =>
        t.test(label, async () => {
          const response = await request(method, route, body, extra);
          assert.equal(response.status, status);
          assert.ok(response.headers.get("x-request-id"));
          const text = await response.text();
          if (code !== undefined)
            assert.equal(JSON.parse(text).error.code, code);
        });
      await check("unknown path", "POST", "/unknown", init, {}, 404);
      await t.test("foreign Host rejects on the wire", async () => {
        const result = await new Promise((resolve, reject) => {
          const req = require("node:http").request(
            base + "/mcp",
            { method: "POST", headers: { ...headers, host: "evil.invalid" } },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify(init));
        });
        assert.equal(result, 403);
      });
      await check(
        "foreign Origin rejects",
        "POST",
        "/mcp",
        init,
        { origin: "http://evil.invalid" },
        403,
      );
      await t.test("CORS preflight preserves protocol headers", async () => {
        const response = await request("OPTIONS", "/mcp", undefined, {
          origin: "http://localhost:9000",
          "access-control-request-method": "POST",
        });
        assert.equal(response.status, 204);
        assert.match(
          response.headers.get("access-control-allow-headers"),
          /mcp-session-id/i,
        );
        assert.match(
          response.headers.get("access-control-allow-headers"),
          /mcp-protocol-version/i,
        );
        assert.match(
          response.headers.get("access-control-expose-headers"),
          /mcp-session-id/i,
        );
      });
      if (protocol === "streamable") {
        for (const method of ["PUT", "PATCH", "HEAD"])
          await t.test(method + " rejects with Allow", async () => {
            const response = await request(method);
            assert.equal(response.status, 405);
            assert.equal(response.headers.get("allow"), "GET, POST, DELETE");
            await response.text();
          });
        await check("malformed JSON", "POST", "/mcp", "{", {}, 400);
        await check(
          "missing SSE Accept",
          "POST",
          "/mcp",
          init,
          { accept: "application/json" },
          406,
          -32000,
        );
        await check(
          "wrong content type",
          "POST",
          "/mcp",
          init,
          { "content-type": "text/plain" },
          415,
          -32000,
        );
        await check(
          "POST requires session or initialize",
          "POST",
          "/mcp",
          { jsonrpc: "2.0", id: 2, method: "ping" },
          {},
          400,
          -32000,
        );
        for (const method of ["GET", "DELETE"])
          await check(
            method + " missing session",
            method,
            "/mcp",
            undefined,
            {},
            400,
            -32000,
          );
        for (const method of ["POST", "GET", "DELETE"])
          await check(
            method + " unknown session",
            method,
            "/mcp",
            method === "POST" ? init : undefined,
            { "mcp-session-id": "unknown" },
            404,
            -32001,
          );
        const response = await request("POST", "/mcp", init);
        assert.equal(response.status, 200);
        const session = response.headers.get("mcp-session-id");
        assert.ok(session);
        assert.equal(
          frame(await response.text()).result.protocolVersion,
          LATEST_PROTOCOL_VERSION,
        );
        const sh = {
          "mcp-session-id": session,
          "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
        };
        await check(
          "initialized notification returns no RPC response",
          "POST",
          "/mcp",
          { jsonrpc: "2.0", method: "notifications/initialized" },
          sh,
          202,
        );
        await check(
          "unsupported protocol version",
          "POST",
          "/mcp",
          { jsonrpc: "2.0", id: 3, method: "ping" },
          { ...sh, "mcp-protocol-version": "invalid" },
          400,
          -32000,
        );
        await check(
          "invalid JSON-RPC envelope",
          "POST",
          "/mcp",
          { invalid: true },
          sh,
          400,
          -32700,
        );
        await check(
          "GET requires event-stream",
          "GET",
          "/mcp",
          undefined,
          { ...sh, accept: "application/json" },
          406,
          -32000,
        );
        await t.test("unknown RPC method retains request id", async () => {
          const response = await request(
            "POST",
            "/mcp",
            { jsonrpc: "2.0", id: 9, method: "unknown/method" },
            sh,
          );
          assert.equal(response.status, 200);
          const result = frame(await response.text());
          assert.equal(result.id, 9);
          assert.equal(result.error.code, -32601);
        });
        await check(
          "DELETE closes session",
          "DELETE",
          "/mcp",
          undefined,
          sh,
          200,
        );
        await check(
          "closed session cannot be reused",
          "POST",
          "/mcp",
          { jsonrpc: "2.0", id: 4, method: "ping" },
          sh,
          404,
          -32001,
        );
      } else {
        await check(
          "POST requires message endpoint",
          "POST",
          "/mcp",
          init,
          {},
          404,
        );
        await check(
          "message endpoint requires session",
          "POST",
          "/mcp/messages",
          init,
          {},
          400,
        );
        await check(
          "unknown session",
          "POST",
          "/mcp/messages?sessionId=unknown",
          init,
          {},
          404,
        );
        const response = await request("GET");
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get("content-type"),
          /text\/event-stream/,
        );
        reader = response.body.getReader();
        let buffer = "";
        while (!buffer.includes("event: endpoint\ndata: "))
          buffer += new TextDecoder().decode((await reader.read()).value);
        const route = buffer.match(/event: endpoint\ndata: ([^\n]+)/)[1];
        assert.match(route, /^\/mcp\/messages\?sessionId=/);
        await check(
          "message content type validated",
          "POST",
          route,
          init,
          { "content-type": "text/plain" },
          400,
        );
        await check("malformed JSON", "POST", route, "{", {}, 400);
        await check(
          "invalid JSON-RPC",
          "POST",
          route,
          { invalid: true },
          {},
          400,
        );
        await check(
          "initialize accepted asynchronously",
          "POST",
          route,
          init,
          {},
          202,
        );
        await t.test(
          "initialization result arrives on SSE message channel",
          async () => {
            while (!buffer.includes('"protocolVersion"'))
              buffer += new TextDecoder().decode((await reader.read()).value);
            const result = buffer
              .split("\n")
              .filter((line) => line.startsWith("data: {"))
              .map((line) => JSON.parse(line.slice(6)))
              .find((value) => value.id === 1);
            assert.equal(
              result.result.protocolVersion,
              LATEST_PROTOCOL_VERSION,
            );
          },
        );
        await reader.cancel();
        reader = undefined;
        let retired = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          const response = await request("POST", route, {
            jsonrpc: "2.0",
            id: 9,
            method: "ping",
          });
          await response.text();
          if (response.status === 404) {
            retired = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(retired, "SSE disconnect retires session");
      }
    },
  );
