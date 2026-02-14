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
- `--connect <true|false>`
- `--reconnect-on-disconnect <true|false>`
- `--reconnect-delay-ms <number>`
- `--reconnect-delay-offline-ms <number>`
- `--ws-enabled <true|false>`
- `--ws-protocol <moblin-xmpp|json>`
- `--ws-host <host>`
- `--ws-port <port>`
- `--ws-token <token>`
- `--gift-to-synthetic-chat <true|false>`
- `--verbosity <error|warn|chat|debug>`

## Adapter Precedence

The CLI always registers its built-in TikTok connector first, then registers the optional `--adapter` connector.  
If both use the same `id`, the adapter wins.
