# @reino-doce/streaming-chat-webservice-cli

Standalone CLI for `@reino-doce/streaming-chat-webservice`.

This package provides:

- `streaming-chat-webservice` executable.
- Built-in TikTok Live connector for standalone usage.
- Optional external adapter loading with `--adapter`.

## Install

```bash
npm install @reino-doce/streaming-chat-webservice-cli
```

## Commands

```bash
streaming-chat-webservice start [--config path] [--adapter module]
streaming-chat-webservice status [--config path] [--adapter module]
```

## Common Options

- `--connector-id <id>`
- `--unique-id <@user>`
- `--process-initial-data <true|false>`
- `--author-mode <username|display-name>`
- `--verbose <true|false>`
- `--verbose-log-path <path>`
- `--connect <true|false>`
- `--monitor <true|false>`
- `--reconnect-on-disconnect <true|false>`
- `--reconnect-delay-ms <number>`
- `--reconnect-delay-offline-ms <number>`
- `--ws-enabled <true|false>`
- `--ws-protocol <uscp-sse/1|moblin-xmpp>`
- `--ws-host <host>`
- `--ws-port <port>`
- `--ws-token <token>`
- `--gift-to-synthetic-chat <true|false>`
- `--verbosity <error|warn|chat|debug>`

## TikTok Raw Verbose Log

- When `--verbose=true`, the TikTok connector writes every raw connector event (webcast + control) in raw mode.
- Each line format is: `<ISO datetime> <raw event JSON>`.
- Default path: `./logs/tiktok-live-connector.log`.
- Override path with `--verbose-log-path <path>` or env `RD_TIKTOK_VERBOSE_LOG_PATH`.
- Use `--monitor=true` to keep the service watching an upstream user and auto-connect when the live starts.

## Adapter Precedence

The CLI always registers its built-in TikTok connector first, then registers the optional `--adapter` connector.  
If both use the same `id`, the adapter wins.
