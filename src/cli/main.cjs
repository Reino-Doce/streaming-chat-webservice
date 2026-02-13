#!/usr/bin/env node

const {
  createStreamingChatRuntime,
  validateRuntimeConfig,
} = require("../index.cjs");
const {
  parseArgs,
  loadConfigFile,
  buildRuntimeConfig,
} = require("./config.cjs");
const { loadAdapter } = require("./adapter-loader.cjs");

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
  --connect <true|false>
  --reconnect-on-disconnect <true|false>
  --reconnect-delay-ms <number>
  --ws-enabled <true|false>
  --ws-protocol <moblin-xmpp|json>
  --ws-host <host>
  --ws-port <port>
  --ws-token <token>
  --gift-to-synthetic-chat <true|false>
`);
}

function logStatus(status) {
  // eslint-disable-next-line no-console
  console.log(
    `[status] connector=${status.connectorId} state=${status.connectorState} room=${status.roomId || "-"} wsRunning=${status.wsRunning} wsClients=${status.wsClientCount}`,
  );
}

function logEvent(event) {
  const type = String(event?.type || "");
  if (type === "chat") {
    const author = String(event?.author?.effectiveName || "unknown");
    // eslint-disable-next-line no-console
    console.log(`[chat] ${author}: ${String(event?.message || "")}`);
    return;
  }

  if (type === "gift") {
    const author = String(event?.author?.effectiveName || "unknown");
    // eslint-disable-next-line no-console
    console.log(`[gift] ${author}: ${String(event?.renderedText || "")}`);
    return;
  }

  if (type === "lifecycle") {
    // eslint-disable-next-line no-console
    console.log(`[lifecycle] ${String(event?.state || "unknown")} ${String(event?.reason || "").trim()}`.trim());
    return;
  }

  if (type === "error") {
    // eslint-disable-next-line no-console
    console.error(`[error] ${String(event?.message || "")}`);
  }
}

async function resolveExecutionContext(options) {
  const fileConfig = loadConfigFile(options.config);
  const adapter = loadAdapter(options.adapter);

  const runtimeConfig = buildRuntimeConfig(fileConfig, options);
  const connectors = adapter ? [adapter] : [];

  const validation = validateRuntimeConfig(runtimeConfig, { connectors });
  if (!validation.ok) {
    for (const error of validation.errors) {
      // eslint-disable-next-line no-console
      console.error(`[invalid-config] ${error}`);
    }
    throw new Error("Configuração inválida.");
  }

  return {
    runtimeConfig: validation.config,
    connectors,
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
    console.error(String(error?.message || error));
    return 1;
  }
}

async function runStart(options) {
  let runtime = null;
  let shuttingDown = false;

  try {
    const { runtimeConfig, connectors } = await resolveExecutionContext(options);
    runtime = createStreamingChatRuntime({ connectors });

    runtime.onStatus(logStatus);
    runtime.onEvent(logEvent);

    await runtime.start(runtimeConfig);

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
    console.error(String(error?.message || error));

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

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(String(error?.message || error));
  process.exit(1);
});
