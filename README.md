# @reino-doce/streaming-chat-webservice

Connector-agnostic runtime for normalized streaming chat events with optional USCP-SSE or Moblin-compatible transport output.

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
    monitor: false,
    reconnectOnDisconnect: true,
    reconnectDelayMs: 5000,
    reconnectDelayOfflineMs: 30000,
    ws: {
      enabled: false,
      protocol: "uscp-sse/1",
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
  "monitor": false,
  "reconnectOnDisconnect": true,
  "reconnectDelayMs": 5000,
  "reconnectDelayOfflineMs": 30000,
  "ws": {
    "enabled": false,
    "protocol": "uscp-sse/1",
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
- `ws.protocol` accepts `moblin-xmpp`; everything else becomes `uscp-sse/1`.
- Legacy `json` WS mode was removed; use `uscp-sse/1` (default) or `moblin-xmpp`.
- If `ws.enabled=true`, `ws.token` is required.
- If `connect=true` or `monitor=true`, `connectorId` is required.
- If `connect=true`, `monitor=true`, or `connectorId` is non-empty, the connector must be registered.

## Monitor Mode

- `monitor=true` turns the runtime into watch mode for the configured upstream user.
- In monitor mode, startup does not fail when the upstream is offline; the runtime keeps retrying in background.
- Retry remains infinite and uses `reconnectDelayMs` for regular disconnects and `reconnectDelayOfflineMs` for offline/live-not-found cases.
- In `uscp-sse/1` mode, monitor lifecycle notices are emitted as `system.upstream.event` with `upstream_event` values like `monitor.connected`, `monitor.offline`, and `monitor.disconnected`.

## USCP Normalization Note

- In `uscp-sse/1` transport mode, protocol frames received as `chat.message` with synthetic gift text (`[GIFT] ...`) are normalized to canonical `monetization.donation.gift` events.
- Source metadata (`source_*`) and author display fields are preserved when present.
- `user_image_id` is preserved/propagated for mapped user events (including like/share normalization paths) so clients can render profile avatars consistently.
- Canonical interaction migration is strict:
  - `interaction.barrage.announced` is replaced by `audience.room_join`.
  - `competition.link_mic.fan_ticket.updated` is replaced by `audience.fan_club.fan_level`.
  - Legacy type codes are dropped when received as protocol events.
- Transport keeps an in-memory `user id -> username` map per source and rewrites known numeric user-id fields in later protocol payloads (for example `from_user_id`) to the known username when possible.
- TikTok `imDelete` events normalize to `moderation.message.delete`; when `deleteMsgIdsList` is empty, connector falls back to `common.msgId` as `message_id`.
- When an event is dropped during USCP serialization, transport logs `console.warn` with reason, type/source, and payload/context snapshot.

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

For TikTok connector raw-event auditing in standalone mode, use:

- `--verbose true` to enable raw event capture.
- `--verbose-log-path <path>` (or env `RD_TIKTOK_VERBOSE_LOG_PATH`) to control output file path.
- `--monitor true` to keep watching an upstream user even while they are offline.

The file defaults to `./logs/tiktok-live-connector.log` and writes one line per event in the format `<ISO datetime> <raw event JSON>`.

That package includes the built-in TikTok connector for standalone use.
