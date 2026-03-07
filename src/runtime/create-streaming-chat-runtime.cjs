const { createMoblinXmppWsTransport } = require("../transports/moblin-xmpp-ws.cjs");
const { createUscpSseHttpTransport } = require("../transports/uscp-sse-http.cjs");
const { createConnectorRegistry } = require("../connectors/registry.cjs");

const DEFAULT_CONFIG = {
  connectorId: "",
  connectorConfig: {},
  connect: false,
  monitor: false,
  reconnectOnDisconnect: true,
  reconnectDelayMs: 5000,
  reconnectDelayOfflineMs: 30000,
  ws: {
    enabled: false,
    protocol: "uscp-sse/1",
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
    monitor: asBoolean(row.monitor, DEFAULT_CONFIG.monitor),
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
      protocol: asString(ws.protocol, DEFAULT_CONFIG.ws.protocol).trim() === "moblin-xmpp"
        ? "moblin-xmpp"
        : "uscp-sse/1",
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
  if (protocol === "moblin-xmpp") {
    return createMoblinXmppWsTransport();
  }
  return createUscpSseHttpTransport();
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

  if ((config.connect || config.monitor) && !config.connectorId) {
    errors.push("connectorId é obrigatório quando connect=true ou monitor=true.");
  }

  const requiresConnector = config.connect || config.monitor || !!config.connectorId;
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
  let activeConnectorPlatform = "";
  let lastRoomId = null;
  let lastSyntheticUpstreamNoticeKey = "";

  function wantsConnection() {
    return !!(config.connect || config.monitor);
  }

  function shouldAutoReconnect() {
    if (!started || !wantsConnection()) return false;
    if (config.monitor) return true;
    return !!config.reconnectOnDisconnect;
  }

  function resetSyntheticUpstreamNotice() {
    lastSyntheticUpstreamNoticeKey = "";
  }

  function getActiveConnectorPlatform() {
    if (activeConnectorPlatform) return activeConnectorPlatform;

    const definition = connectorRegistry.get(config.connectorId);
    const platform = asString(definition?.platform, "").trim();
    return platform || "stream";
  }

  function emitSyntheticUpstreamNotice({ upstreamEvent, state, summary, reason = "", roomId = null }) {
    const eventName = asString(upstreamEvent, "").trim();
    const nextState = asString(state, "").trim();
    const text = asString(summary, "").trim();
    const normalizedRoomId = asString(roomId, "").trim();
    const key = `${config.connectorId}|${eventName}|${normalizedRoomId}`;

    if (!eventName || !nextState || !text) return;
    if (lastSyntheticUpstreamNoticeKey === key) return;

    lastSyntheticUpstreamNoticeKey = key;

    const payload = {
      summary: text,
      upstream: asString(config.connectorId, "").trim() || "runtime",
      upstream_event: eventName,
      state: nextState,
    };

    const normalizedReason = asString(reason, "").trim();
    if (normalizedReason) {
      payload.reason = normalizedReason;
    }

    if (normalizedRoomId) {
      payload.source_room_id = normalizedRoomId;
    }

    handleConnectorEvent({
      type: "protocol",
      platform: getActiveConnectorPlatform(),
      at: Date.now(),
      typeCode: "system.upstream.event",
      payload,
    });
  }

  function notifyLifecycleStatus({ state, reason = "", roomId = null, force = false }) {
    if (!config.monitor) return;
    if (!force && disconnecting) return;

    const normalizedState = asString(state, "").trim();
    const normalizedReason = asString(reason, "").trim();
    const normalizedRoomId = asString(roomId, "").trim();

    if (normalizedState === "connected") {
      const summary = normalizedRoomId
        ? `Conectado ao chat. Sala: ${normalizedRoomId}.`
        : "Conectado ao chat.";
      emitSyntheticUpstreamNotice({
        upstreamEvent: "monitor.connected",
        state: "connected",
        summary,
        roomId: normalizedRoomId,
      });
      return;
    }

    if (normalizedState !== "disconnected") {
      return;
    }

    if (isOfflineReconnectReason(normalizedReason)) {
      emitSyntheticUpstreamNotice({
        upstreamEvent: "monitor.offline",
        state: "offline",
        summary: "Usuário ficou offline.",
        reason: normalizedReason,
        roomId: normalizedRoomId || lastRoomId,
      });
      return;
    }

    const summary = normalizedReason
      ? `Conexão com o chat perdida. Motivo: ${normalizedReason}.`
      : "Conexão com o chat perdida.";
    emitSyntheticUpstreamNotice({
      upstreamEvent: "monitor.disconnected",
      state: "disconnected",
      summary,
      reason: normalizedReason,
      roomId: normalizedRoomId || lastRoomId,
    });
  }

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

  function broadcastProtocolEventIfEnabled(event) {
    if (!config.ws.enabled || !transport) return;
    if (config.ws.protocol !== "uscp-sse/1") return;

    try {
      transport.broadcastEvent(event);
    } catch {}
  }

  function scheduleReconnect(reason) {
    if (!shouldAutoReconnect()) return;

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

    if (type === "protocol") {
      const typeCode = asString(event.typeCode, "").trim();
      const payload = asObject(event.payload, {});
      if (!typeCode || !payload || typeof payload !== "object") {
        return;
      }

      if (typeCode === "chat.message") {
        status.totalChatCount += 1;

        if (config.ws.enabled && transport && config.ws.protocol === "moblin-xmpp") {
          const message = asString(payload.message_text, "").trim();
          if (message) {
            const author =
              asString(payload.user_displayname, "").trim() ||
              extractAuthorName(event.author);

            try {
              transport.broadcastChat({
                platform: asString(event.platform, "stream").trim() || "stream",
                author,
                message,
              });
            } catch {}
          }
        }
      }

      if (typeCode === "monetization.donation.gift") {
        status.totalGiftCount += 1;

        if (
          config.ws.enabled &&
          transport &&
          config.ws.protocol === "moblin-xmpp" &&
          config.giftToSyntheticChat
        ) {
          const giftId = asString(payload.gift_id, "").trim();
          const donationValue = asString(payload.donation_value, "").trim();
          const author =
            asString(payload.user_displayname, "").trim() ||
            extractAuthorName(event.author);
          const message = giftId
            ? `[GIFT] ${giftId}${donationValue ? ` (${donationValue})` : ""}`
            : donationValue;

          if (message) {
            try {
              transport.broadcastChat({
                platform: asString(event.platform, "stream").trim() || "stream",
                author,
                message,
              });
            } catch {}
          }
        }
      }

      broadcastProtocolEventIfEnabled(event);
      emitEvent(event);
      publishStatus();
      return;
    }

    if (type === "chat") {
      const message = asString(event.message, "").trim();
      if (!message) return;

      status.totalChatCount += 1;

      if (config.ws.enabled && transport && config.ws.protocol === "moblin-xmpp") {
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

      broadcastProtocolEventIfEnabled(event);

      emitEvent(event);
      publishStatus();
      return;
    }

    if (type === "gift") {
      status.totalGiftCount += 1;

      broadcastProtocolEventIfEnabled(event);

      if (
        config.ws.enabled &&
        transport &&
        config.ws.protocol === "moblin-xmpp" &&
        config.giftToSyntheticChat
      ) {
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
        lastRoomId = status.roomId;
        status.lastError = "";
        notifyLifecycleStatus({
          state: "connected",
          roomId: status.roomId,
        });
      } else if (lifecycleState === "reconnecting") {
        status.connectorState = "reconnecting";
      } else if (lifecycleState === "disconnected") {
        const disconnectedRoomId = status.roomId || lastRoomId;
        status.roomId = null;

        const reason = asString(event.reason, "").trim();
        if (reason) {
          status.lastError = reason;
        }

        if (!disconnecting) {
          notifyLifecycleStatus({
            state: "disconnected",
            reason,
            roomId: disconnectedRoomId,
          });
        }

        if (disconnecting || !wantsConnection()) {
          status.connectorState = "idle";
        } else if (shouldAutoReconnect()) {
          scheduleReconnect(reason || status.lastError);
        } else {
          status.connectorState = "idle";
        }
      }

      emitEvent(event);
      broadcastProtocolEventIfEnabled(event);
      publishStatus();
      return;
    }

    if (type === "error") {
      const message = asString(event.message, "Erro desconhecido do conector.").trim();
      status.lastError = message;

      emitEvent(event);
      if (!asBoolean(event.suppressStream, false)) {
        broadcastProtocolEventIfEnabled(event);
      }
      publishStatus();
      return;
    }

    broadcastProtocolEventIfEnabled(event);
    emitEvent(event);
  }

  async function disconnectConnector({ manual = false } = {}) {
    clearReconnectTimer();

    connectAttempt += 1;

    if (!connectorInstance) {
      status.connectorState = "idle";
      status.roomId = null;
      if (manual) {
        lastRoomId = null;
        activeConnectorPlatform = "";
        resetSyntheticUpstreamNotice();
      }
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
    lastRoomId = null;
    activeConnectorPlatform = "";
    resetSyntheticUpstreamNotice();
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
    activeConnectorPlatform = asString(definition.platform, "").trim() || activeConnectorPlatform;
    let sawDisconnectedLifecycle = false;

    status.connectorId = config.connectorId;
    status.connectorState = status.connectorState === "reconnecting" ? "reconnecting" : "connecting";
    status.lastError = "";
    publishStatus();

    try {
      await instance.connect(config.connectorConfig, (event) => {
        if (attemptId !== connectAttempt || connectorInstance !== instance) return;

        if (asString(event?.type, "").trim() === "lifecycle") {
          const lifecycleState = asString(event?.state, "").trim();
          if (lifecycleState === "disconnected") {
            sawDisconnectedLifecycle = true;
          }
        }

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
        notifyLifecycleStatus({
          state: "connected",
          roomId: status.roomId,
        });
        emitEvent(event);
        broadcastProtocolEventIfEnabled(event);
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
        suppressStream: !!config.monitor,
      };
      emitEvent(event);
      broadcastProtocolEventIfEnabled(event);

      if (!sawDisconnectedLifecycle) {
        notifyLifecycleStatus({
          state: "disconnected",
          reason: message,
          roomId: lastRoomId,
          force: true,
        });
      }

      if (shouldAutoReconnect()) {
        scheduleReconnect(message);
      }

      if (throwOnError) {
        throw error;
      }
    }
  }

  async function reconcileConnection({ throwOnError = false } = {}) {
    if (!started) return;

    if (!wantsConnection()) {
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
    await reconcileConnection({ throwOnError: config.connect && !config.monitor });

    return cloneStatus(status);
  }

  async function update(configPatch) {
    config = mergeRuntimeConfig(config, configPatch);
    status.connectorId = config.connectorId;

    if (!started) {
      started = true;
    }

    applyWsConfig();

    const patchRow = asObject(configPatch, {});
    const shouldThrow =
      (
        Object.prototype.hasOwnProperty.call(patchRow, "connect") ||
        Object.prototype.hasOwnProperty.call(patchRow, "monitor")
      )
        ? !!(config.connect && !config.monitor)
        : false;

    await reconcileConnection({ throwOnError: shouldThrow });

    return cloneStatus(status);
  }

  async function stop() {
    started = false;
    clearReconnectTimer();

    config = mergeRuntimeConfig(config, {
      connect: false,
      monitor: false,
      ws: {
        enabled: false,
      },
    });

    await disconnectConnector({ manual: true });
    stopTransport();

    status.wsRunning = false;
    status.wsClientCount = 0;
    status.wsLastError = "";
    activeConnectorPlatform = "";
    lastRoomId = null;
    resetSyntheticUpstreamNotice();
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
