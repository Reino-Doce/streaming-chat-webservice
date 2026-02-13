let connectorModule = null;
let connectorLoadFailed = false;

function asString(value, fallback = "") {
  const text = String(value ?? fallback);
  return text === "undefined" || text === "null" ? fallback : text;
}

function normalizeUniqueId(value) {
  return asString(value, "").trim().replace(/^@+/, "").toLowerCase();
}

function getConnectorModule() {
  if (connectorModule) return connectorModule;
  if (connectorLoadFailed) return null;

  try {
    connectorModule = require("tiktok-live-connector");
    return connectorModule;
  } catch (error) {
    connectorLoadFailed = true;
    return null;
  }
}

function formatConnectError(error) {
  const message = asString(error?.message ?? error, "").trim();
  const nestedErrors = Array.isArray(error?.errors)
    ? error.errors.map((entry) => asString(entry?.message ?? entry, "")).join(" | ")
    : "";
  const combined = `${message} ${nestedErrors}`.toLowerCase();

  if (combined.includes("user_not_found")) {
    return "Usuário do TikTok não encontrado. Verifique o @ informado.";
  }

  if (combined.includes("fetchisliveerror")) {
    return "Não foi possível confirmar a live. Verifique se o usuário está ao vivo e tente novamente.";
  }

  if (combined.includes("euler") && combined.includes("permission")) {
    return "Falha ao resolver a sala da live. Ajustamos para não usar fallback Euler; tente conectar novamente.";
  }

  if (message) return message;
  return "Falha ao conectar no TikTok Live.";
}

function extractAuthorIdentity(data, authorMode = "username") {
  const row = data && typeof data === "object" ? data : {};
  const user = row.user && typeof row.user === "object" ? row.user : {};

  const username = asString(row.uniqueId, "").trim() || asString(user.uniqueId, "").trim();
  const displayName = asString(row.nickname, "").trim() || asString(user.nickname, "").trim();
  const id = asString(row.userId, "").trim() || asString(user.userId, "").trim();

  const effectiveName =
    authorMode === "display-name"
      ? displayName || username || id || "Desconhecido"
      : username || displayName || id || "Desconhecido";

  return {
    id: id || undefined,
    username: username || undefined,
    displayName: displayName || undefined,
    effectiveName,
  };
}

function buildGiftText(giftData) {
  const row = giftData && typeof giftData === "object" ? giftData : {};
  const giftDetails = row.giftDetails && typeof row.giftDetails === "object" ? row.giftDetails : {};

  const giftId = Math.floor(Number(row.giftId) || 0);
  const giftNameRaw = asString(giftDetails.giftName, "").trim();
  const giftName = giftNameRaw || (giftId ? `Gift #${giftId}` : "Gift");
  const repeatCount = Math.max(1, Math.floor(Number(row.repeatCount) || 1));
  const repeatEnd = Math.floor(Number(row.repeatEnd) || 0) === 1;
  const diamondEach = Math.floor(Number(giftDetails.diamondCount) || 0);
  const totalDiamonds = diamondEach > 0 ? diamondEach * repeatCount : 0;
  const diamondsText = totalDiamonds > 0 ? ` 💎${totalDiamonds}` : "";
  const statusEmoji = repeatEnd ? " ✅" : " …";
  return `[GIFT] 🎁 ${giftName} x${repeatCount}${diamondsText}${statusEmoji}`;
}

function createTikTokLiveConnector() {
  return {
    id: "tiktok-live",
    platform: "tiktok",
    create() {
      let connection = null;

      async function disconnect() {
        if (!connection) return;

        const activeConnection = connection;
        connection = null;

        try {
          activeConnection.removeAllListeners();
        } catch {}

        try {
          await activeConnection.disconnect();
        } catch {}
      }

      async function connect(rawConfig, emit) {
        await disconnect();

        const connector = getConnectorModule();
        if (!connector) {
          throw new Error("Biblioteca TikTok-Live-Connector não está disponível.");
        }

        if (typeof emit !== "function") {
          throw new Error("Connector emit callback é obrigatório.");
        }

        const { TikTokLiveConnection, WebcastEvent, ControlEvent } = connector;
        const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

        const uniqueId = normalizeUniqueId(config.uniqueId);
        if (!uniqueId) {
          throw new Error("Defina o @usuário da live do TikTok para conectar.");
        }

        const processInitialData = !!config.processInitialData;
        const authorMode = asString(config.authorMode, "username").trim() === "display-name"
          ? "display-name"
          : "username";

        emit({
          type: "lifecycle",
          at: Date.now(),
          state: "connecting",
        });

        const candidate = new TikTokLiveConnection(uniqueId, {
          processInitialData,
          disableEulerFallbacks: true,
        });
        connection = candidate;

        candidate.on(ControlEvent.CONNECTED, (state) => {
          if (connection !== candidate) return;

          emit({
            type: "lifecycle",
            at: Date.now(),
            state: "connected",
            roomId: asString(state?.roomId, "") || null,
          });
        });

        candidate.on(ControlEvent.DISCONNECTED, (event) => {
          if (connection !== candidate) return;

          connection = null;
          emit({
            type: "lifecycle",
            at: Date.now(),
            state: "disconnected",
            reason: asString(event?.reason, ""),
          });
        });

        candidate.on(ControlEvent.ERROR, (error) => {
          if (connection !== candidate) return;
          emit({
            type: "error",
            at: Date.now(),
            message: formatConnectError(error),
            fatal: false,
            raw: error,
          });
        });

        candidate.on(WebcastEvent.CHAT, (chatData) => {
          if (connection !== candidate) return;

          const message = asString(chatData?.comment, "").trim();
          if (!message) return;

          emit({
            type: "chat",
            platform: "tiktok",
            at: Date.now(),
            author: extractAuthorIdentity(chatData, authorMode),
            message,
            raw: chatData,
          });
        });

        candidate.on(WebcastEvent.GIFT, (giftData) => {
          if (connection !== candidate) return;

          emit({
            type: "gift",
            platform: "tiktok",
            at: Date.now(),
            author: extractAuthorIdentity(giftData, authorMode),
            renderedText: buildGiftText(giftData),
            raw: giftData,
          });
        });

        try {
          const state = await candidate.connect();
          if (connection !== candidate) {
            try {
              await candidate.disconnect();
            } catch {}
            return;
          }

          emit({
            type: "lifecycle",
            at: Date.now(),
            state: "connected",
            roomId: asString(state?.roomId, "") || null,
          });
        } catch (error) {
          if (connection === candidate) {
            connection = null;
          }

          const message = formatConnectError(error);
          emit({
            type: "error",
            at: Date.now(),
            message,
            fatal: false,
            raw: error,
          });
          emit({
            type: "lifecycle",
            at: Date.now(),
            state: "disconnected",
            reason: message,
          });

          throw new Error(message);
        }
      }

      return {
        connect,
        disconnect,
      };
    },
  };
}

module.exports = {
  createTikTokLiveConnector,
};
