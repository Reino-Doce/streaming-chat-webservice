# @reino-doce/streaming-chat-webservice

Standalone runtime and CLI for streaming chat connectors with Moblin-compatible WebSocket output.

## What This Package Does

`@reino-doce/streaming-chat-webservice` gives you:

- A connector-driven runtime (`createStreamingChatRuntime`) that normalizes incoming stream events.
- A built-in TikTok Live connector (`createTikTokLiveConnector`).
- Optional WebSocket output in:
  - `moblin-xmpp` mode (XMPP-like frames for Moblin compatibility).
  - `json` mode (raw normalized events as JSON).
- A CLI (`streaming-chat-webservice`) for starting and validating runtime configuration.

## Install

```bash
npm install @reino-doce/streaming-chat-webservice
```

For local development in this repository:

```bash
npm install
node src/cli/main.cjs --help
```

## Quick Start (CLI)

Create a config file:

```json
{
  "connectorId": "tiktok-live",
  "connectorConfig": {
    "uniqueId": "your_tiktok_user",
    "processInitialData": false,
    "authorMode": "username"
  },
  "connect": true,
  "reconnectOnDisconnect": true,
  "reconnectDelayMs": 5000,
  "ws": {
    "enabled": true,
    "protocol": "moblin-xmpp",
    "host": "0.0.0.0",
    "port": 5443,
    "token": "change-me"
  },
  "giftToSyntheticChat": true
}
```

Validate resolved config:

```bash
streaming-chat-webservice status --config ./runtime.config.json
```

Start runtime:

```bash
streaming-chat-webservice start --config ./runtime.config.json
```

Override fields from CLI:

```bash
streaming-chat-webservice start \
  --config ./runtime.config.json \
  --unique-id @your_tiktok_user \
  --ws-enabled true \
  --ws-protocol json \
  --ws-port 5444 \
  --ws-token dev-token
```

## CLI Commands

`streaming-chat-webservice start [--config path] [--adapter module]`

- Starts runtime, logs connector events and status, and keeps process alive.
- Stops gracefully on `SIGINT`/`SIGTERM`.

`streaming-chat-webservice status [--config path] [--adapter module]`

- Validates config and prints the resolved runtime config.
- Does not start connector or server.

## CLI Options

Supported overrides:

- `--connector-id <id>`
- `--unique-id <@user>`
- `--process-initial-data <true|false>`
- `--author-mode <username|display-name>`
- `--connect <true|false>`
- `--reconnect-on-disconnect <true|false>`
- `--reconnect-delay-ms <number>`
- `--ws-enabled <true|false>`
- `--ws-protocol <moblin-xmpp|json>`
- `--ws-host <host>`
- `--ws-port <port>`
- `--ws-token <token>`
- `--gift-to-synthetic-chat <true|false>`
- `--adapter <module-or-path>`

Values can be passed as `--key value` or `--key=value`.

## Runtime Config Reference

Default runtime config:

```json
{
  "connectorId": "tiktok-live",
  "connectorConfig": {
    "uniqueId": "",
    "processInitialData": false,
    "authorMode": "username"
  },
  "connect": true,
  "reconnectOnDisconnect": true,
  "reconnectDelayMs": 5000,
  "ws": {
    "enabled": false,
    "protocol": "moblin-xmpp",
    "host": "0.0.0.0",
    "port": 5443,
    "token": ""
  },
  "giftToSyntheticChat": true
}
```

Normalization and validation rules:

- `reconnectDelayMs` is clamped to `1000..60000`.
- `ws.port` is clamped to `1024..65535`.
- `ws.protocol` accepts `json`; all other values become `moblin-xmpp`.
- If `ws.enabled=true`, `ws.token` is required.
- If `connect=true` and `connectorId=tiktok-live`, `connectorConfig.uniqueId` is required.

## Programmatic API

CommonJS:

```js
const {
  createStreamingChatRuntime,
  validateRuntimeConfig,
} = require("@reino-doce/streaming-chat-webservice");

const runtime = createStreamingChatRuntime();

runtime.onStatus((status) => {
  console.log("[status]", status);
});

runtime.onEvent((event) => {
  console.log("[event]", event.type, event);
});

const rawConfig = {
  connectorId: "tiktok-live",
  connectorConfig: { uniqueId: "your_tiktok_user" },
  connect: true,
  reconnectOnDisconnect: true,
  reconnectDelayMs: 5000,
  ws: {
    enabled: true,
    protocol: "json",
    host: "127.0.0.1",
    port: 5443,
    token: "dev-token",
  },
  giftToSyntheticChat: true,
};

const validation = validateRuntimeConfig(rawConfig);
if (!validation.ok) {
  throw new Error(validation.errors.join("; "));
}

async function main() {
  await runtime.start(validation.config);
  // ... later
  await runtime.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

ESM:

```js
import {
  createStreamingChatRuntime,
  validateRuntimeConfig,
} from "@reino-doce/streaming-chat-webservice";
```

### Exported API Surface

- `createStreamingChatRuntime(args?)`
- `createTikTokLiveConnector()`
- `validateRuntimeConfig(rawConfig, args?)`

Type definitions are provided in `index.d.ts`.

## Event Model

Normalized runtime events:

- `chat`: `platform`, `author`, `message`, `at`
- `gift`: `platform`, `author`, `renderedText`, `at`
- `lifecycle`: `state` (`connecting|connected|reconnecting|disconnected`), optional `roomId`, optional `reason`
- `error`: `message`, `fatal`, optional `raw`

`giftToSyntheticChat=true` mirrors gift text to chat broadcast output when WebSocket transport is enabled.

## WebSocket Output Modes

### `moblin-xmpp`

- Uses WebSocket subprotocol `xmpp`.
- Token auth is query-string based: `?token=<ws.token>`.
- Sends XMPP-like stanzas for features/auth/bind and chat messages.
- Chat message format uses sender `platform/author`.

Connection example:

```txt
ws://127.0.0.1:5443/ws?token=dev-token
subprotocol: xmpp
```

### `json`

- WebSocket path is `/ws`.
- Token auth is query-string based: `?token=<ws.token>`.
- Broadcasts normalized runtime events as JSON strings.

Connection example:

```txt
ws://127.0.0.1:5443/ws?token=dev-token
```

## Custom Connectors and CLI Adapters

Connector definition contract:

```js
module.exports = {
  id: "my-connector",
  platform: "my-platform",
  create() {
    return {
      async connect(config, emit) {
        emit({ type: "lifecycle", at: Date.now(), state: "connected" });
      },
      async disconnect() {},
    };
  },
};
```

Use with CLI:

```bash
streaming-chat-webservice start --adapter ./my-connector.cjs --connector-id my-connector
```

The adapter loader accepts:

- direct module export,
- `default` export,
- or `connector` export.

## Runtime Status Fields

`getStatus()` and `onStatus()` provide:

- `connectorId`
- `connectorState` (`idle|connecting|connected|reconnecting`)
- `roomId`
- `lastError`
- `totalChatCount`
- `totalGiftCount`
- `wsRunning`
- `wsClientCount`
- `wsLastError`

## Repository Verification Commands

- Install: `npm install`
- Smoke: `node src/cli/main.cjs --help`
- Test: not configured
- Typecheck: not configured
