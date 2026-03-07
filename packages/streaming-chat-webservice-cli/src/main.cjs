#!/usr/bin/env node

const {
  createStreamingChatRuntime,
  validateRuntimeConfig,
} = require("@reino-doce/streaming-chat-webservice");
const {
  parseArgs,
  loadConfigFile,
  buildRuntimeConfig,
  resolveVerbosity,
} = require("./config.cjs");
const { loadAdapter } = require("./adapter-loader.cjs");
const { createTikTokLiveConnector } = require("./connectors/tiktok-live-connector.cjs");

const VERBOSITY_WEIGHTS = {
  error: 0,
  warn: 1,
  chat: 2,
  debug: 3,
};

function shouldLog(verbosity, minimumLevel) {
  const current = VERBOSITY_WEIGHTS[String(verbosity || "").trim()] ?? VERBOSITY_WEIGHTS.warn;
  const required = VERBOSITY_WEIGHTS[String(minimumLevel || "").trim()] ?? VERBOSITY_WEIGHTS.warn;
  return current >= required;
}

function formatLogText(value, fallback = "", seen = new Set()) {
  if (typeof value === "string") {
    const text = value.trim();
    return text || fallback;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return fallback;
    seen.add(value);

    const row = value;
    const nestedMessage = formatLogText(row.message, "", seen);
    if (nestedMessage) return nestedMessage;

    const nestedReason = formatLogText(row.reason, "", seen);
    if (nestedReason) return nestedReason;

    try {
      const serialized = JSON.stringify(row);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {}
  }

  const text = String(value ?? "").trim();
  if (!text || text === "[object Object]" || text === "undefined" || text === "null") {
    return fallback;
  }
  return text;
}

function summarizeProtocolPayload(typeCode, payload) {
  const row = payload && typeof payload === "object" ? payload : {};
  const byType = {
    "chat.message": ["message_text", "user_displayname", "source_message_id"],
    "monetization.donation.gift": ["gift_id", "donation_value", "user_displayname", "source_message_id"],
    "audience.member.entered": ["user_displayname", "member_count", "enter_type", "source_message_id"],
    "audience.room.presence.updated": ["viewer_count", "total_user", "popularity", "source_message_id"],
    "audience.followage.updated": ["user_displayname", "followage_type", "follow_count", "source_message_id"],
    "interaction.reaction.like": ["user_displayname", "reaction_amount", "total_like_count", "source_message_id"],
    "interaction.reaction.share": ["user_displayname", "reaction_amount", "share_count", "source_message_id"],
    "interaction.social.activity": ["user_displayname", "social_action", "share_count", "source_message_id"],
    "audience.room_join": ["sub_type", "content", "level_value", "barrage_user_displayname", "source_message_id"],
    "audience.fan_club.fan_level": ["fan_level", "top_user_nickname", "total_link_mic_fan_ticket", "source_message_id"],
    "stream.goal.progress.updated": ["goal_id", "contribute_count", "contribute_score", "source_message_id"],
    "stream.caption.segment.published": ["content", "timestamp_ms", "duration_ms", "source_message_id"],
    "stream.notice.announced": ["content", "scene", "source_type", "source_message_id"],
    "stream.intro.updated": ["host_nickname", "description", "language", "source_message_id"],
    "stream.control.updated": ["control_action", "message_scene", "tips", "source_message_id"],
    "stream.lifecycle.ended": ["end_action", "action", "source_message_id"],
    "stream.banner.in_room.updated": ["banner_state", "source_message_id"],
    "competition.link_mic_battle.started": ["battle_id", "battle_action", "source_message_id"],
    "competition.link_mic_battle.points.updated": ["battle_id", "battle_status", "channel_id", "source_message_id"],
    "competition.link_mic_battle.punishment.finished": ["battle_id", "channel_id", "source_message_id"],
    "competition.link_mic_battle.task.updated": ["battle_id", "task_message_type", "source_message_id"],
    "competition.link.message.updated": ["message_type", "scene", "linker_id", "expire_timestamp", "source_message_id"],
    "competition.link.layer.updated": ["message_type", "scene", "channel_id", "leave_user_id", "kickout_user_id", "source_message_id"],
  };

  const keys = byType[typeCode] || ["source_message_id", "source_room_id"];
  const pairs = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    pairs.push(`${key}=${formatLogText(value, "")}`);
  }
  return pairs.join(" ");
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`streaming-chat-webservice

Usage:
  streaming-chat-webservice start [--config path] [--adapter module]
  streaming-chat-webservice status [--config path] [--adapter module]

Common overrides:
  --connector-id <id>
  --unique-id <@user>
  --process-initial-data <true|false>
  --author-mode <username|display-name>
  --verbose <true|false>
  --verbose-log-path <path>
  --connect <true|false>
  --monitor <true|false>
  --reconnect-on-disconnect <true|false>
  --reconnect-delay-ms <number>
  --reconnect-delay-offline-ms <number>
  --ws-enabled <true|false>
  --ws-protocol <uscp-sse/1|moblin-xmpp>
  --ws-host <host>
  --ws-port <port>
  --ws-token <token>
  --gift-to-synthetic-chat <true|false>
  --verbosity <error|warn|chat|debug>
`);
}

function createLogger(verbosity) {
  const activeVerbosity = String(verbosity || "").trim() || "warn";

  function logStatus(status) {
    if (!shouldLog(activeVerbosity, "debug")) return;
    const wsError = formatLogText(status?.wsLastError, "").replace(/\s+/g, " ").trim();
    const wsErrorText = wsError ? ` wsError=${wsError}` : "";
    // eslint-disable-next-line no-console
    console.log(
      `[status] connector=${status.connectorId} state=${status.connectorState} room=${status.roomId || "-"} wsRunning=${status.wsRunning} wsClients=${status.wsClientCount}${wsErrorText}`,
    );
  }

  function logEvent(event) {
    const type = String(event?.type || "");
    if (type === "chat") {
      if (!shouldLog(activeVerbosity, "chat")) return;
      const author = String(event?.author?.effectiveName || "unknown");
      // eslint-disable-next-line no-console
      console.log(`[chat] ${author}: ${String(event?.message || "")}`);
      return;
    }

    if (type === "gift") {
      if (!shouldLog(activeVerbosity, "chat")) return;
      const author = String(event?.author?.effectiveName || "unknown");
      // eslint-disable-next-line no-console
      console.log(`[gift] ${author}: ${String(event?.renderedText || "")}`);
      return;
    }

    if (type === "lifecycle") {
      const state = formatLogText(event?.state, "unknown");
      const reason = formatLogText(event?.reason, "");

      if (state === "disconnected" || state === "reconnecting") {
        if (!shouldLog(activeVerbosity, "warn")) return;
        if (state === "disconnected" && !reason) return;
        // eslint-disable-next-line no-console
        console.warn(`[warn] ${state}${reason ? `: ${reason}` : ""}`);
        return;
      }

      if (!shouldLog(activeVerbosity, "debug")) return;
      // eslint-disable-next-line no-console
      console.log(`[lifecycle] ${state}${reason ? ` ${reason}` : ""}`);
      return;
    }

    if (type === "error") {
      if (!shouldLog(activeVerbosity, "error")) return;
      // eslint-disable-next-line no-console
      console.error(`[error] ${formatLogText(event?.message, "Erro desconhecido do conector.")}`);
      return;
    }

    if (type === "protocol") {
      const typeCode = formatLogText(event?.typeCode, "unknown");
      const platform = formatLogText(event?.platform, "stream");
      const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};

      if (typeCode === "chat.message" && shouldLog(activeVerbosity, "chat")) {
        const author = formatLogText(payload.user_displayname, "unknown");
        const message = formatLogText(payload.message_text, "");
        if (message) {
          // eslint-disable-next-line no-console
          console.log(`[chat] ${author}: ${message}`);
        }
      }

      if (typeCode === "monetization.donation.gift" && shouldLog(activeVerbosity, "chat")) {
        const author = formatLogText(payload.user_displayname, "unknown");
        const giftId = formatLogText(payload.gift_id, "");
        const donationValue = formatLogText(payload.donation_value, "");
        const suffix = donationValue ? ` (${donationValue})` : "";
        if (giftId || donationValue) {
          // eslint-disable-next-line no-console
          console.log(`[gift] ${author}: ${giftId || "gift"}${suffix}`);
        }
      }

      if (!shouldLog(activeVerbosity, "debug")) return;
      const summary = summarizeProtocolPayload(typeCode, event?.payload);
      // eslint-disable-next-line no-console
      console.log(`[event] protocol source=${platform} type=${typeCode}${summary ? ` ${summary}` : ""}`);
      return;
    }

    if (shouldLog(activeVerbosity, "debug")) {
      // eslint-disable-next-line no-console
      console.log(`[event] ${type || "unknown"}`);
    }
  }

  return {
    logStatus,
    logEvent,
  };
}

function buildConnectors(adapter) {
  const connectors = [createTikTokLiveConnector()];
  if (adapter) {
    connectors.push(adapter);
  }
  return connectors;
}

function normalizeTikTokUniqueId(value) {
  return String(value ?? "").trim().replace(/^@+/, "");
}

function validateCliRuntimeConfig(runtimeConfig) {
  const errors = [];
  const connectorId = String(runtimeConfig?.connectorId || "").trim();

  if ((runtimeConfig?.connect || runtimeConfig?.monitor) && connectorId === "tiktok-live") {
    const uniqueId = normalizeTikTokUniqueId(runtimeConfig?.connectorConfig?.uniqueId);
    if (!uniqueId) {
      errors.push("uniqueId do TikTok é obrigatório quando connect=true ou monitor=true.");
    } else {
      runtimeConfig.connectorConfig = {
        ...(runtimeConfig.connectorConfig || {}),
        uniqueId,
      };
    }
  }

  return errors;
}

async function waitForWsStartup(runtime, runtimeConfig, timeoutMs = 2000) {
  if (!runtimeConfig?.ws?.enabled) return;

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = runtime.getStatus();
    if (snapshot?.wsRunning) {
      return;
    }

    const wsLastError = formatLogText(snapshot?.wsLastError, "").trim();
    if (wsLastError) {
      throw new Error(
        `Falha ao iniciar transporte '${runtimeConfig.ws.protocol}' em ${runtimeConfig.ws.host}:${runtimeConfig.ws.port}: ${wsLastError}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const snapshot = runtime.getStatus();
  if (snapshot?.wsRunning) {
    return;
  }

  const wsLastError = formatLogText(snapshot?.wsLastError, "").trim();
  if (wsLastError) {
    throw new Error(
      `Falha ao iniciar transporte '${runtimeConfig.ws.protocol}' em ${runtimeConfig.ws.host}:${runtimeConfig.ws.port}: ${wsLastError}`,
    );
  }

  throw new Error(
    `Transporte '${runtimeConfig.ws.protocol}' não confirmou inicialização em ${runtimeConfig.ws.host}:${runtimeConfig.ws.port}.`,
  );
}

async function resolveExecutionContext(options) {
  const fileConfig = loadConfigFile(options.config);
  const adapter = loadAdapter(options.adapter);
  const verbosity = resolveVerbosity(fileConfig, options);

  const runtimeConfig = buildRuntimeConfig(fileConfig, options);
  const connectors = buildConnectors(adapter);
  const cliErrors = validateCliRuntimeConfig(runtimeConfig);

  const validation = validateRuntimeConfig(runtimeConfig, { connectors });
  const errors = [...cliErrors, ...validation.errors];
  if (errors.length > 0) {
    for (const error of errors) {
      // eslint-disable-next-line no-console
      console.error(`[invalid-config] ${error}`);
    }
    throw new Error("Configuração inválida.");
  }

  return {
    runtimeConfig: validation.config,
    connectors,
    verbosity,
  };
}

async function runStatus(options) {
  try {
    const { runtimeConfig } = await resolveExecutionContext(options);

    // eslint-disable-next-line no-console
    console.log("status: ok");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(runtimeConfig, null, 2));
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(formatLogText(error?.message ?? error, "Erro ao validar configuração."));
    return 1;
  }
}

async function runStart(options) {
  let runtime = null;
  let shuttingDown = false;

  try {
    const { runtimeConfig, connectors, verbosity } = await resolveExecutionContext(options);
    runtime = createStreamingChatRuntime({ connectors });
    const logger = createLogger(verbosity);

    runtime.onStatus(logger.logStatus);
    runtime.onEvent(logger.logEvent);

    await runtime.start(runtimeConfig);
    await waitForWsStartup(runtime, runtimeConfig);

    const shutdown = async (exitCode) => {
      if (shuttingDown) return;
      shuttingDown = true;

      try {
        if (runtime) {
          await runtime.stop();
        }
      } catch {}

      process.exit(exitCode);
    };

    process.on("SIGINT", () => {
      shutdown(0);
    });

    process.on("SIGTERM", () => {
      shutdown(0);
    });

    await new Promise(() => {});
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(formatLogText(error?.message ?? error, "Falha ao iniciar runtime."));

    if (runtime) {
      try {
        await runtime.stop();
      } catch {}
    }

    return 1;
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "start") {
    const code = await runStart(options);
    process.exit(code);
  }

  if (command === "status") {
    const code = await runStatus(options);
    process.exit(code);
  }

  printHelp();
  process.exit(command === "help" ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(formatLogText(error?.message ?? error, "Falha inesperada."));
    process.exit(1);
  });
}

module.exports = {
  buildConnectors,
  resolveExecutionContext,
  runStatus,
  runStart,
  main,
};
