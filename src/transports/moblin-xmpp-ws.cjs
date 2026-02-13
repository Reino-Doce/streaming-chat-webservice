const { WebSocketServer } = require("ws");

function escapeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildFeaturesStanza() {
  return "<features><mechanisms><mechanism>PLAIN</mechanism></mechanisms></features>";
}

function buildSuccessStanza() {
  return "<success/>";
}

function buildBindResponseStanza(jid) {
  return `<iq><bind><jid>${escapeXmlText(jid)}</jid></bind></iq>`;
}

function buildChatMessageStanza({ from, body }) {
  return `<message from=\"${escapeXmlText(from)}\"><body>${escapeXmlText(body)}</body></message>`;
}

function createStatusSnapshot({ running, clientCount, lastError }) {
  return {
    running: !!running,
    clientCount: Math.max(0, Number(clientCount) || 0),
    lastError: String(lastError ?? "").trim(),
  };
}

function createMoblinXmppWsTransport() {
  let wss = null;
  let listening = false;
  let config = null;
  let lastError = "";
  let onStatusChange = null;
  const clientState = new Map();

  function publishStatus() {
    if (typeof onStatusChange !== "function") return;

    try {
      onStatusChange(
        createStatusSnapshot({
          running: listening,
          clientCount: clientState.size,
          lastError,
        }),
      );
    } catch {}
  }

  function safeSend(ws, message) {
    try {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(message);
    } catch {}
  }

  function closeAllClients() {
    if (!wss) return;
    for (const ws of wss.clients) {
      try {
        ws.close(1001, "server closing");
      } catch {}
    }
  }

  function stop() {
    config = null;
    lastError = "";
    listening = false;

    if (!wss) {
      publishStatus();
      return;
    }

    closeAllClients();

    const activeServer = wss;
    wss = null;
    clientState.clear();

    try {
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
      handleProtocols: (protocols) => (protocols.has("xmpp") ? "xmpp" : false),
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

      clientState.set(ws, { authenticated: false });
      publishStatus();
      safeSend(ws, buildFeaturesStanza());

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;

        const text = String(data ?? "");
        const lower = text.toLowerCase();

        if (lower.includes("<auth")) {
          const state = clientState.get(ws);
          if (state) state.authenticated = true;
          safeSend(ws, buildSuccessStanza());
          safeSend(ws, buildFeaturesStanza());
          return;
        }

        if (lower.includes("<iq") && lower.includes("<bind")) {
          safeSend(ws, buildBindResponseStanza("stream@internal/moblin"));
        }
      });

      ws.on("close", () => {
        clientState.delete(ws);
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

  function broadcastChat({ platform, author, message }) {
    if (!wss) return;

    const sender = String(author ?? "unknown").trim() || "unknown";
    const body = String(message ?? "").trim();
    const platformName = String(platform ?? "stream").trim() || "stream";
    if (!body) return;

    const stanza = buildChatMessageStanza({
      from: `${platformName}/${sender}`,
      body,
    });

    for (const ws of wss.clients) {
      const state = clientState.get(ws);
      if (!state?.authenticated) continue;
      safeSend(ws, stanza);
    }
  }

  function broadcastEvent(_event) {
    // No-op for XMPP mode.
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
  createMoblinXmppWsTransport,
};
