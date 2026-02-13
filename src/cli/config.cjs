const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  connectorId: "tiktok-live",
  connectorConfig: {
    uniqueId: "",
    processInitialData: false,
    authorMode: "username",
  },
  connect: true,
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

const VALID_VERBOSITY_LEVELS = new Set(["error", "warn", "chat", "debug"]);
const DEFAULT_VERBOSITY = "warn";

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    if (normalized === "1") return true;
    if (normalized === "0") return false;
  }
  return fallback;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" ? value : fallback;
}

function normalizeVerbosity(value, fallback = DEFAULT_VERBOSITY) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (VALID_VERBOSITY_LEVELS.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function resolveVerbosity(fileConfig, options) {
  const configRow = asObject(fileConfig, {});
  const optionRow = asObject(options, {});

  if (Object.prototype.hasOwnProperty.call(optionRow, "verbosity")) {
    return normalizeVerbosity(optionRow.verbosity, DEFAULT_VERBOSITY);
  }

  return normalizeVerbosity(configRow.verbosity, DEFAULT_VERBOSITY);
}

function parseArgs(argv) {
  const values = Array.isArray(argv) ? argv : [];
  const first = values[0] || "";

  let command = "help";
  let index = 0;

  if (first && !first.startsWith("-")) {
    command = first;
    index = 1;
  }

  const options = {};

  while (index < values.length) {
    const token = values[index];
    index += 1;

    if (!token || !token.startsWith("--")) continue;

    const equalsIndex = token.indexOf("=");
    if (equalsIndex >= 0) {
      const key = token.slice(2, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      options[key] = value;
      continue;
    }

    const key = token.slice(2);
    const next = values[index];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = "true";
    }
  }

  return {
    command,
    options,
  };
}

function loadConfigFile(configPath) {
  if (!configPath) {
    return {};
  }

  const resolvedPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const parsed = JSON.parse(raw);
  return asObject(parsed, {});
}

function buildRuntimeConfig(fileConfig, options) {
  const base = {
    ...DEFAULT_CONFIG,
    ...asObject(fileConfig, {}),
    connectorConfig: {
      ...DEFAULT_CONFIG.connectorConfig,
      ...asObject(fileConfig?.connectorConfig, {}),
    },
    ws: {
      ...DEFAULT_CONFIG.ws,
      ...asObject(fileConfig?.ws, {}),
    },
  };

  const config = {
    ...base,
    connectorConfig: {
      ...base.connectorConfig,
    },
    ws: {
      ...base.ws,
    },
  };

  if (Object.prototype.hasOwnProperty.call(options, "connector-id")) {
    config.connectorId = String(options["connector-id"] || "").trim() || config.connectorId;
  }

  if (Object.prototype.hasOwnProperty.call(options, "unique-id")) {
    config.connectorConfig.uniqueId = String(options["unique-id"] || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(options, "process-initial-data")) {
    config.connectorConfig.processInitialData = asBoolean(
      options["process-initial-data"],
      !!config.connectorConfig.processInitialData,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, "author-mode")) {
    config.connectorConfig.authorMode = String(options["author-mode"] || "").trim() === "display-name"
      ? "display-name"
      : "username";
  }

  if (Object.prototype.hasOwnProperty.call(options, "connect")) {
    config.connect = asBoolean(options.connect, !!config.connect);
  }

  if (Object.prototype.hasOwnProperty.call(options, "reconnect-on-disconnect")) {
    config.reconnectOnDisconnect = asBoolean(
      options["reconnect-on-disconnect"],
      !!config.reconnectOnDisconnect,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, "reconnect-delay-ms")) {
    config.reconnectDelayMs = Math.max(
      1000,
      Math.min(60000, Math.floor(asNumber(options["reconnect-delay-ms"], config.reconnectDelayMs))),
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, "reconnect-delay-offline-ms")) {
    config.reconnectDelayOfflineMs = Math.max(
      1000,
      Math.min(
        600000,
        Math.floor(asNumber(options["reconnect-delay-offline-ms"], config.reconnectDelayOfflineMs)),
      ),
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, "ws-enabled")) {
    config.ws.enabled = asBoolean(options["ws-enabled"], !!config.ws.enabled);
  }

  if (Object.prototype.hasOwnProperty.call(options, "ws-protocol")) {
    config.ws.protocol = String(options["ws-protocol"] || "").trim() === "json"
      ? "json"
      : "moblin-xmpp";
  }

  if (Object.prototype.hasOwnProperty.call(options, "ws-host")) {
    config.ws.host = String(options["ws-host"] || "").trim() || config.ws.host;
  }

  if (Object.prototype.hasOwnProperty.call(options, "ws-port")) {
    config.ws.port = Math.max(
      1024,
      Math.min(65535, Math.floor(asNumber(options["ws-port"], config.ws.port))),
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, "ws-token")) {
    config.ws.token = String(options["ws-token"] || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(options, "gift-to-synthetic-chat")) {
    config.giftToSyntheticChat = asBoolean(
      options["gift-to-synthetic-chat"],
      !!config.giftToSyntheticChat,
    );
  }

  return config;
}

module.exports = {
  parseArgs,
  loadConfigFile,
  buildRuntimeConfig,
  resolveVerbosity,
};
