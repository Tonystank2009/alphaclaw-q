const crypto = require("crypto");
const { WebSocket } = require("ws");
const { readOpenclawConfig } = require("./openclaw-config");

const kProtocolVersion = 3;
const kConnectTimeoutMs = 8000;
const kDefaultCallTimeoutMs = 30000;
const kEnvRefPattern = /^\$\{([A-Z0-9_]+)\}$/i;
const kScopes = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

const resolveTokenValue = (candidate = "") => {
  const trimmed = String(candidate || "").trim();
  if (!trimmed) return "";
  const m = trimmed.match(kEnvRefPattern);
  if (!m) return trimmed;
  return String(process.env[m[1]] || "").trim();
};

const buildSessionKey = (agentId) =>
  `agent:${String(agentId || "").trim().toLowerCase()}:main`;

const createGatewayCaller = ({ openclawDir, getGatewayPort = () => 18789 }) => {
  let socket = null;
  let connectingPromise = null;
  const pendingRequests = new Map();
  const runs = new Map();

  const getToken = () => {
    const envToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
    if (envToken) return envToken;
    const cfg = readOpenclawConfig({ openclawDir, fallback: {} });
    return resolveTokenValue(cfg?.gateway?.auth?.token);
  };

  const cleanupSocket = (reason) => {
    socket = null;
    connectingPromise = null;
    for (const [, run] of runs) {
      try { run.reject(new Error(reason || "gateway disconnected")); } catch {}
    }
    runs.clear();
    for (const [, p] of pendingRequests) {
      try { p.reject(new Error(reason || "gateway disconnected")); } catch {}
    }
    pendingRequests.clear();
  };

  const handleEvent = (eventPayload) => {
    if (eventPayload?.event !== "agent") return;
    const payload = eventPayload?.payload || {};
    const runId = String(payload?.runId || payload?.run?.id || "").trim();
    if (!runId) return;
    const run = runs.get(runId);
    if (!run) return;
    if (payload.stream === "assistant") {
      const data = payload.data || {};
      const delta =
        data.delta == null || data.delta === "" ? data.text : data.delta;
      if (delta) run.buffer += String(delta);
      return;
    }
    if (payload.stream === "lifecycle" && payload.data?.phase === "end") {
      runs.delete(runId);
      clearTimeout(run.timeout);
      run.resolve(run.buffer.trim());
      return;
    }
  };

  const ensureConnected = () => {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (connectingPromise) return connectingPromise;

    connectingPromise = new Promise((resolve, reject) => {
      const port = getGatewayPort();
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const connectId = crypto.randomUUID();
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { ws.close(); } catch {}
        reject(new Error("gateway connect timeout"));
      }, kConnectTimeoutMs);

      ws.on("message", (raw) => {
        let p = null;
        try { p = JSON.parse(String(raw)); } catch { return; }
        if (!p || typeof p !== "object") return;

        if (p.type === "event" && p.event === "connect.challenge") {
          ws.send(JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: kProtocolVersion,
              maxProtocol: kProtocolVersion,
              client: {
                id: "gateway-client",
                version: "0.1.0",
                platform: process.platform,
                mode: "backend",
              },
              role: "operator",
              scopes: kScopes,
              caps: ["tool-events"],
              commands: [],
              permissions: {},
              auth: { token: getToken() },
              locale: "en-US",
              userAgent: "alphaclaw-backend-call/0.1.0",
            },
          }));
          return;
        }

        if (p.type === "res") {
          if (String(p.id || "") === connectId) {
            if (p.ok && p?.payload?.type === "hello-ok") {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              socket = ws;
              resolve(ws);
              return;
            }
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { ws.close(); } catch {}
            reject(new Error(p?.error?.message || "gateway connect failed"));
            return;
          }
          const pending = pendingRequests.get(String(p.id || ""));
          if (pending) {
            pendingRequests.delete(String(p.id));
            if (p.ok) pending.resolve(p.payload || null);
            else pending.reject(new Error(p?.error?.message || "gateway request failed"));
          }
          return;
        }

        if (p.type === "event") handleEvent(p);
      });

      ws.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        cleanupSocket("gateway socket error");
      });

      ws.on("close", () => {
        cleanupSocket("gateway socket closed");
      });
    }).finally(() => {
      connectingPromise = null;
    });

    return connectingPromise;
  };

  const requestGateway = async (method, params, timeoutMs = 15000) => {
    const ws = await ensureConnected();
    const id = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`gateway ${method} timeout`));
      }, timeoutMs);
      pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  };

  const callAgent = async ({ agentId, message, timeoutMs = kDefaultCallTimeoutMs }) => {
    const sessionKey = buildSessionKey(agentId);
    if (!agentId) throw new Error("agentId required");
    if (!message) throw new Error("message required");

    await ensureConnected();

    // Pre-register a run watcher; runId comes from chat.send response
    const runPromise = new Promise((resolve, reject) => {
      requestGateway("chat.send", {
        sessionKey,
        message,
        idempotencyKey: crypto.randomUUID(),
      }, timeoutMs)
        .then((result) => {
          const runId = String(result?.runId || "").trim();
          if (!runId) {
            reject(new Error("chat.send returned no runId"));
            return;
          }
          const timeout = setTimeout(() => {
            runs.delete(runId);
            reject(new Error("agent run timeout"));
          }, timeoutMs);
          runs.set(runId, {
            buffer: "",
            resolve,
            reject,
            timeout,
          });
        })
        .catch(reject);
    });

    return await runPromise;
  };

  return { callAgent, requestGateway, ensureConnected };
};

module.exports = { createGatewayCaller, buildSessionKey };
