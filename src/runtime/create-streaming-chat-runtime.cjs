const { createMoblinXmppWsTransport } = require("../transports/moblin-xmpp-ws.cjs");
const { createJsonWsTransport } = require("../transports/json-ws.cjs");
const { createConnectorRegistry } = require("../connectors/registry.cjs");

const DEFAULT_CONFIG = {
  connectorId: "",
  connectorConfig: {},
  connect: false,
  reconnectOnDisconnect: true,
  reconnectDelayMs: 5000,
  reconnectDelayOfflineMs: 30000,
  ws: {
    enabled: false,
    protocol: "moblin-xmpp",
    host: "0.0.0.0",
    port: 5443,
    token: "",
  },
  giftToSyntheticChat: true,
};

function asObject(value, fallback = {}) {
  return value && typeof value === "object" ? value : fallback;
}

function asString(value, fallback = "") {
  const text = String(value ?? fallback);
  return text === "undefined" || text === "null" ? fallback : text;
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isOfflineReconnectReason(reason) {
  const text = asString(reason, "").trim().toLowerCase();
  if (!text) return false;

  return (
    text.includes("isn't online") ||
    text.includes("is not online") ||
    text.includes("not online") ||
    text.includes("não está ao vivo") ||
    text.includes("nao esta ao vivo") ||
    text.includes("não foi possível confirmar a live") ||
    text.includes("nao foi possivel confirmar a live")
  );
}

function sanitizeRuntimeConfig(rawConfig) {
  const row = asObject(rawConfig, {});
  const ws = asObject(row.ws, {});
  const connectorId = asString(row.connectorId, DEFAULT_CONFIG.connectorId).trim() || DEFAULT_CONFIG.connectorId;
  const connectorConfig = {
    ...asObject(DEFAULT_CONFIG.connectorConfig, {}),
    ...asObject(row.connectorConfig, {}),
  };

  return {
    connectorId,
    connectorConfig,
    connect: asBoolean(row.connect, DEFAULT_CONFIG.connect),
    reconnectOnDisconnect: asBoolean(
      row.reconnectOnDisconnect,
      DEFAULT_CONFIG.reconnectOnDisconnect,
    ),
    reconnectDelayMs: Math.max(
      1000,
      Math.min(60000, Math.floor(asNumber(row.reconnectDelayMs, DEFAULT_CONFIG.reconnectDelayMs))),
    ),
    reconnectDelayOfflineMs: Math.max(
      1000,
      Math.min(
        600000,
        Math.floor(asNumber(row.reconnectDelayOfflineMs, DEFAULT_CONFIG.reconnectDelayOfflineMs)),
      ),
    ),
    ws: {
      enabled: asBoolean(ws.enabled, DEFAULT_CONFIG.ws.enabled),
      protocol: asString(ws.protocol, DEFAULT_CONFIG.ws.protocol).trim() === "json"
        ? "json"
        : "moblin-xmpp",
      host: asString(ws.host, DEFAULT_CONFIG.ws.host).trim() || DEFAULT_CONFIG.ws.host,
      port: Math.max(
        1024,
        Math.min(65535, Math.floor(asNumber(ws.port, DEFAULT_CONFIG.ws.port))),
      ),
      token: asString(ws.token, DEFAULT_CONFIG.ws.token).trim(),
    },
    giftToSyntheticChat: asBoolean(
      row.giftToSyntheticChat,
      DEFAULT_CONFIG.giftToSyntheticChat,
    ),
  };
}

function mergeRuntimeConfig(baseConfig, patchConfig) {
  const base = sanitizeRuntimeConfig(baseConfig);
  const patch = asObject(patchConfig, {});

  const merged = {
    ...base,
    ...patch,
    connectorConfig: {
      ...asObject(base.connectorConfig, {}),
      ...asObject(patch.connectorConfig, {}),
    },
    ws: {
      ...asObject(base.ws, {}),
      ...asObject(patch.ws, {}),
    },
  };

  return sanitizeRuntimeConfig(merged);
}

function createDefaultStatus() {
  return {
    connectorId: DEFAULT_CONFIG.connectorId,
    connectorState: "idle",
    roomId: null,
    lastError: "",
    totalChatCount: 0,
    totalGiftCount: 0,
    wsRunning: false,
    wsClientCount: 0,
    wsLastError: "",
  };
}

function cloneStatus(status) {
  return {
    ...status,
  };
}

function createWsTransport(protocol) {
  if (protocol === "json") {
    return createJsonWsTransport();
  }
  return createMoblinXmppWsTransport();
}

function extractAuthorName(author) {
  const row = asObject(author, {});
  const candidates = [
    row.effectiveName,
    row.displayName,
    row.username,
    row.id,
  ];

  for (const candidate of candidates) {
    const value = asString(candidate, "").trim();
    if (value) return value;
  }

  return "Desconhecido";
}

function validateRuntimeConfig(rawConfig, args = {}) {
  const connectorRegistry = createConnectorRegistry(args.connectors);
  const config = sanitizeRuntimeConfig(rawConfig);
  const errors = [];

  if (config.connect && !config.connectorId) {
    errors.push("connectorId é obrigatório quando connect=true.");
  }

  const requiresConnector = config.connect || !!config.connectorId;
  if (requiresConnector && config.connectorId && !connectorRegistry.get(config.connectorId)) {
    errors.push(`Connector '${config.connectorId}' não foi encontrado.`);
  }

  if (config.ws.enabled && !config.ws.token) {
    errors.push("Token do WebSocket é obrigatório quando WS está habilitado.");
  }

  return {
    ok: errors.length === 0,
    errors,
    config,
  };
}

function createStreamingChatRuntime(args = {}) {
  const connectorRegistry = createConnectorRegistry(args.connectors);

  const eventListeners = new Set();
  const statusListeners = new Set();

  let config = sanitizeRuntimeConfig(DEFAULT_CONFIG);
  let status = createDefaultStatus();

  let started = false;
  let connectorInstance = null;
  let transport = null;
  let transportProtocol = "";
  let reconnectTimer = null;
  let disconnecting = false;
  let connectAttempt = 0;

  function emitEvent(event) {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  function publishStatus() {
    const snapshot = cloneStatus(status);
    for (const listener of statusListeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function stopTransport() {
    if (!transport) return;

    try {
      transport.stop();
    } catch {}

    transport = null;
    transportProtocol = "";
  }

  function syncTransportStatus(snapshot) {
    const row = asObject(snapshot, {});
    status.wsRunning = !!row.running;
    status.wsClientCount = Math.max(0, Math.floor(asNumber(row.clientCount, 0)));
    status.wsLastError = asString(row.lastError, "").trim();
    publishStatus();
  }

  function applyWsConfig() {
    if (!config.ws.enabled) {
      stopTransport();
      status.wsRunning = false;
      status.wsClientCount = 0;
      status.wsLastError = "";
      publishStatus();
      return;
    }

    if (!config.ws.token) {
      stopTransport();
      status.wsRunning = false;
      status.wsClientCount = 0;
      status.wsLastError = "Defina um token para o WebSocket.";
      publishStatus();
      return;
    }

    if (!transport || transportProtocol !== config.ws.protocol) {
      stopTransport();
      transport = createWsTransport(config.ws.protocol);
      transportProtocol = config.ws.protocol;
    }

    try {
      transport.restart({
        host: config.ws.host,
        port: config.ws.port,
        token: config.ws.token,
        onStatusChange: syncTransportStatus,
      });
    } catch (error) {
      status.wsRunning = false;
      status.wsClientCount = 0;
      status.wsLastError = asString(error?.message ?? error, "Falha ao iniciar WebSocket.");
      publishStatus();
    }
  }

  function broadcastJsonEventIfEnabled(event) {
    if (!config.ws.enabled || config.ws.protocol !== "json" || !transport) return;

    try {
      transport.broadcastEvent(event);
    } catch {}
  }

  function scheduleReconnect(reason) {
    if (!started || !config.connect || !config.reconnectOnDisconnect) return;

    clearReconnectTimer();

    status.connectorState = "reconnecting";
    if (reason) {
      status.lastError = reason;
    }
    publishStatus();

    const delayMs = isOfflineReconnectReason(reason)
      ? config.reconnectDelayOfflineMs
      : config.reconnectDelayMs;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectConnector({ throwOnError: false }).catch(() => {});
    }, delayMs);
  }

  function handleConnectorEvent(event) {
    if (!event || typeof event !== "object") return;

    const type = asString(event.type, "").trim();

    if (type === "chat") {
      const message = asString(event.message, "").trim();
      if (!message) return;

      status.totalChatCount += 1;

      if (config.ws.enabled && transport) {
        const author = extractAuthorName(event.author);
        const platform = asString(event.platform, "stream").trim() || "stream";

        try {
          transport.broadcastChat({
            platform,
            author,
            message,
          });
        } catch {}
      }

      emitEvent(event);
      publishStatus();
      return;
    }

    if (type === "gift") {
      status.totalGiftCount += 1;

      broadcastJsonEventIfEnabled(event);

      if (config.ws.enabled && transport && config.giftToSyntheticChat) {
        const giftText = asString(event.renderedText, "").trim();
        if (giftText) {
          try {
            transport.broadcastChat({
              platform: asString(event.platform, "stream").trim() || "stream",
              author: extractAuthorName(event.author),
              message: giftText,
            });
          } catch {}
        }
      }

      emitEvent(event);
      publishStatus();
      return;
    }

    if (type === "lifecycle") {
      const lifecycleState = asString(event.state, "").trim();

      if (lifecycleState === "connecting") {
        status.connectorState = "connecting";
      } else if (lifecycleState === "connected") {
        status.connectorState = "connected";
        status.roomId = asString(event.roomId, "") || null;
        status.lastError = "";
      } else if (lifecycleState === "reconnecting") {
        status.connectorState = "reconnecting";
      } else if (lifecycleState === "disconnected") {
        status.roomId = null;

        const reason = asString(event.reason, "").trim();
        if (reason) {
          status.lastError = reason;
        }

        if (disconnecting || !config.connect) {
          status.connectorState = "idle";
        } else {
          scheduleReconnect(reason || status.lastError);
        }
      }

      emitEvent(event);
      broadcastJsonEventIfEnabled(event);
      publishStatus();
      return;
    }

    if (type === "error") {
      const message = asString(event.message, "Erro desconhecido do conector.").trim();
      status.lastError = message;

      emitEvent(event);
      broadcastJsonEventIfEnabled(event);
      publishStatus();
      return;
    }

    emitEvent(event);
  }

  async function disconnectConnector({ manual = false } = {}) {
    clearReconnectTimer();

    connectAttempt += 1;

    if (!connectorInstance) {
      status.connectorState = "idle";
      status.roomId = null;
      if (manual) {
        status.lastError = "";
      }
      publishStatus();
      return;
    }

    disconnecting = true;

    const activeConnector = connectorInstance;
    connectorInstance = null;

    try {
      await activeConnector.disconnect();
    } catch {}

    disconnecting = false;

    status.connectorState = "idle";
    status.roomId = null;
    if (manual) {
      status.lastError = "";
    }
    publishStatus();
  }

  async function connectConnector({ throwOnError = true } = {}) {
    clearReconnectTimer();

    const definition = connectorRegistry.get(config.connectorId);
    if (!definition) {
      const error = new Error(`Connector '${config.connectorId}' não foi encontrado.`);
      status.lastError = error.message;
      publishStatus();
      if (throwOnError) throw error;
      return;
    }

    if (connectorInstance && status.connectorState === "connected") {
      return;
    }

    const attemptId = ++connectAttempt;
    const instance = definition.create();
    connectorInstance = instance;

    status.connectorId = config.connectorId;
    status.connectorState = status.connectorState === "reconnecting" ? "reconnecting" : "connecting";
    status.lastError = "";
    publishStatus();

    try {
      await instance.connect(config.connectorConfig, (event) => {
        if (attemptId !== connectAttempt || connectorInstance !== instance) return;
        handleConnectorEvent(event);
      });

      if (attemptId !== connectAttempt || connectorInstance !== instance) {
        try {
          await instance.disconnect();
        } catch {}
        return;
      }

      if (status.connectorState === "connecting" || status.connectorState === "reconnecting") {
        status.connectorState = "connected";
        status.lastError = "";
        publishStatus();

        const event = {
          type: "lifecycle",
          at: Date.now(),
          state: "connected",
          roomId: status.roomId,
        };
        emitEvent(event);
        broadcastJsonEventIfEnabled(event);
      }
    } catch (error) {
      if (attemptId !== connectAttempt) {
        return;
      }

      if (connectorInstance === instance) {
        connectorInstance = null;
      }

      const message = asString(error?.message ?? error, "Falha ao conectar conector.").trim();
      status.connectorState = "idle";
      status.roomId = null;
      status.lastError = message;
      publishStatus();

      const event = {
        type: "error",
        at: Date.now(),
        message,
        fatal: false,
        raw: error,
      };
      emitEvent(event);
      broadcastJsonEventIfEnabled(event);

      if (config.connect && started && config.reconnectOnDisconnect) {
        scheduleReconnect(message);
      }

      if (throwOnError) {
        throw error;
      }
    }
  }

  async function reconcileConnection({ throwOnError = false } = {}) {
    if (!started) return;

    if (!config.connect) {
      await disconnectConnector({ manual: true });
      return;
    }

    if (status.connectorState === "connecting" || status.connectorState === "reconnecting") {
      return;
    }

    if (status.connectorState === "connected" && connectorInstance) {
      return;
    }

    await connectConnector({ throwOnError });
  }

  async function start(nextConfig) {
    if (started) {
      return update(nextConfig);
    }

    config = sanitizeRuntimeConfig(nextConfig);
    status.connectorId = config.connectorId;
    started = true;

    applyWsConfig();
    await reconcileConnection({ throwOnError: config.connect });

    return cloneStatus(status);
  }

  async function update(configPatch) {
    config = mergeRuntimeConfig(config, configPatch);
    status.connectorId = config.connectorId;

    if (!started) {
      started = true;
    }

    applyWsConfig();

    const shouldThrow = Object.prototype.hasOwnProperty.call(asObject(configPatch, {}), "connect")
      ? !!configPatch.connect
      : false;

    await reconcileConnection({ throwOnError: shouldThrow });

    return cloneStatus(status);
  }

  async function stop() {
    started = false;
    clearReconnectTimer();

    config = mergeRuntimeConfig(config, {
      connect: false,
      ws: {
        enabled: false,
      },
    });

    await disconnectConnector({ manual: true });
    stopTransport();

    status.wsRunning = false;
    status.wsClientCount = 0;
    status.wsLastError = "";
    publishStatus();

    return cloneStatus(status);
  }

  function getStatus() {
    return cloneStatus(status);
  }

  function onEvent(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }

  function onStatus(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    statusListeners.add(listener);
    listener(cloneStatus(status));

    return () => {
      statusListeners.delete(listener);
    };
  }

  return {
    start,
    update,
    stop,
    getStatus,
    onEvent,
    onStatus,
  };
}

module.exports = {
  createStreamingChatRuntime,
  validateRuntimeConfig,
};
