# @reino-doce/streaming-chat-webservice

Connector-agnostic runtime for normalized streaming chat events with optional Moblin-compatible WebSocket output.

## What This Package Does

- Provides `createStreamingChatRuntime()` for event normalization, reconnect handling, and WS fanout.
- Provides `validateRuntimeConfig()` for runtime config normalization/validation.
- Does **not** bundle platform connectors.

You must register connector definitions in your host program.

## Install

```bash
npm install @reino-doce/streaming-chat-webservice
```

## Programmatic Usage

```js
const {
  createStreamingChatRuntime,
  validateRuntimeConfig,
} = require("@reino-doce/streaming-chat-webservice");

const mockConnector = {
  id: "my-connector",
  platform: "my-platform",
  create() {
    return {
      async connect(_config, emit) {
        emit({ type: "lifecycle", at: Date.now(), state: "connected", roomId: "room-1" });
      },
      async disconnect() {},
    };
  },
};

const runtime = createStreamingChatRuntime({ connectors: [mockConnector] });

const validation = validateRuntimeConfig(
  {
    connectorId: "my-connector",
    connectorConfig: {},
    connect: true,
    reconnectOnDisconnect: true,
    reconnectDelayMs: 5000,
    reconnectDelayOfflineMs: 30000,
    ws: {
      enabled: false,
      protocol: "moblin-xmpp",
      host: "127.0.0.1",
      port: 5443,
      token: "",
    },
    giftToSyntheticChat: true,
  },
  { connectors: [mockConnector] },
);

if (!validation.ok) {
  throw new Error(validation.errors.join("; "));
}

runtime.start(validation.config);
```

## Runtime Config Defaults

```json
{
  "connectorId": "",
  "connectorConfig": {},
  "connect": false,
  "reconnectOnDisconnect": true,
  "reconnectDelayMs": 5000,
  "reconnectDelayOfflineMs": 30000,
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

## Validation Rules

- `reconnectDelayMs` is clamped to `1000..60000`.
- `reconnectDelayOfflineMs` is clamped to `1000..600000`.
- `ws.port` is clamped to `1024..65535`.
- `ws.protocol` accepts `json`; everything else becomes `moblin-xmpp`.
- If `ws.enabled=true`, `ws.token` is required.
- If `connect=true`, `connectorId` is required.
- If `connect=true` or `connectorId` is non-empty, the connector must be registered.

## Exported API Surface

- `createStreamingChatRuntime(args?)`
- `validateRuntimeConfig(rawConfig, args?)`

Type definitions are in `index.d.ts`.

## Standalone CLI

Standalone executable support moved to:

- `@reino-doce/streaming-chat-webservice-cli`

Install and run:

```bash
npm install @reino-doce/streaming-chat-webservice-cli
streaming-chat-webservice --help
```

That package includes the built-in TikTok connector for standalone use.
