const { WebSocketServer } = require("ws");

function createStatusSnapshot({ running, clientCount, lastError }) {
  return {
    running: !!running,
    clientCount: Math.max(0, Number(clientCount) || 0),
    lastError: String(lastError ?? "").trim(),
  };
}

function createJsonWsTransport() {
  let wss = null;
  let listening = false;
  let config = null;
  let lastError = "";
  let onStatusChange = null;

  function publishStatus() {
    if (typeof onStatusChange !== "function") return;

    try {
      onStatusChange(
        createStatusSnapshot({
          running: listening,
          clientCount: wss ? wss.clients.size : 0,
          lastError,
        }),
      );
    } catch {}
  }

  function safeSend(ws, payload) {
    try {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(payload);
    } catch {}
  }

  function stop() {
    config = null;
    lastError = "";
    listening = false;

    if (!wss) {
      publishStatus();
      return;
    }

    const activeServer = wss;
    wss = null;

    try {
      for (const client of activeServer.clients) {
        try {
          client.close(1001, "server closing");
        } catch {}
      }
      activeServer.close(() => {
        listening = false;
        publishStatus();
      });
    } catch {
      listening = false;
      publishStatus();
    }
  }

  function parseTokenFromRequest(req) {
    try {
      const rawUrl = String(req?.url ?? "/");
      const url = new URL(rawUrl, "http://localhost");
      return String(url.searchParams.get("token") ?? "");
    } catch {
      return "";
    }
  }

  function start({ host, port, token, onStatusChange: nextOnStatusChange }) {
    stop();

    config = {
      host: String(host || "0.0.0.0").trim() || "0.0.0.0",
      port: Math.max(0, Math.floor(Number(port) || 0)),
      token: String(token || ""),
    };
    onStatusChange = typeof nextOnStatusChange === "function" ? nextOnStatusChange : null;
    lastError = "";

    const expectedToken = config.token;

    wss = new WebSocketServer({
      host: config.host,
      port: config.port,
      path: "/ws",
    });

    wss.on("listening", () => {
      listening = true;
      publishStatus();
    });

    wss.on("error", (error) => {
      listening = false;
      lastError = String(error?.message ?? error);
      publishStatus();
    });

    wss.on("connection", (ws, req) => {
      const tokenFromRequest = parseTokenFromRequest(req);
      if (!expectedToken || tokenFromRequest !== expectedToken) {
        try {
          ws.close(1008, "invalid token");
        } catch {}
        return;
      }

      publishStatus();

      ws.on("close", () => {
        publishStatus();
      });

      ws.on("error", () => {});
    });
  }

  function restart({ host, port, token, onStatusChange: nextOnStatusChange }) {
    const nextConfig = {
      host: String(host || "0.0.0.0").trim() || "0.0.0.0",
      port: Math.max(0, Math.floor(Number(port) || 0)),
      token: String(token || ""),
    };

    const same =
      !!wss &&
      !!config &&
      config.host === nextConfig.host &&
      config.port === nextConfig.port &&
      config.token === nextConfig.token;

    if (same) {
      onStatusChange = typeof nextOnStatusChange === "function" ? nextOnStatusChange : null;
      publishStatus();
      return;
    }

    start({
      host: nextConfig.host,
      port: nextConfig.port,
      token: nextConfig.token,
      onStatusChange: nextOnStatusChange,
    });
  }

  function broadcastEvent(event) {
    if (!wss) return;

    let payload = "{}";
    try {
      payload = JSON.stringify(event ?? {});
    } catch {
      payload = "{}";
    }

    for (const ws of wss.clients) {
      safeSend(ws, payload);
    }
  }

  function broadcastChat({ platform, author, message }) {
    const body = String(message ?? "").trim();
    if (!body) return;

    broadcastEvent({
      type: "chat",
      platform: String(platform ?? "stream").trim() || "stream",
      at: Date.now(),
      author: {
        effectiveName: String(author ?? "unknown").trim() || "unknown",
      },
      message: body,
    });
  }

  return {
    start,
    stop,
    restart,
    broadcastChat,
    broadcastEvent,
  };
}

module.exports = {
  createJsonWsTransport,
};
