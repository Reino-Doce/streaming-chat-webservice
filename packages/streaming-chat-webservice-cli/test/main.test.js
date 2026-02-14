// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import streamingChatPackage from "@reino-doce/streaming-chat-webservice";
import cliMainPackage from "../src/main.cjs";

const { createStreamingChatRuntime } = streamingChatPackage;
const { resolveExecutionContext } = cliMainPackage;

const tempDirs = [];

function createTempAdapter(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streaming-chat-cli-test-"));
  const filePath = path.join(dir, "adapter.cjs");
  fs.writeFileSync(filePath, source, "utf8");
  tempDirs.push(dir);
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("cli main", () => {
  it("includes built-in tiktok connector by default", async () => {
    const { connectors } = await resolveExecutionContext({ connect: "false" });

    expect(connectors.some((connector) => connector.id === "tiktok-live")).toBe(true);
  });

  it("loads optional adapter connector", async () => {
    const adapterPath = createTempAdapter(`
module.exports = {
  id: "custom-connector",
  platform: "custom",
  create() {
    return {
      async connect(_config, emit) {
        emit({ type: "lifecycle", at: Date.now(), state: "connected", roomId: "custom-room" });
      },
      async disconnect() {},
    };
  },
};
`);

    const context = await resolveExecutionContext({
      adapter: adapterPath,
      "connector-id": "custom-connector",
      connect: "false",
    });

    expect(context.connectors.map((connector) => connector.id)).toEqual([
      "tiktok-live",
      "custom-connector",
    ]);
    expect(context.runtimeConfig.connectorId).toBe("custom-connector");
  });

  it("lets adapter override built-in tiktok connector id", async () => {
    const adapterPath = createTempAdapter(`
module.exports = {
  id: "tiktok-live",
  platform: "mock",
  create() {
    return {
      async connect(_config, emit) {
        emit({ type: "lifecycle", at: Date.now(), state: "connected", roomId: "adapter-room" });
      },
      async disconnect() {},
    };
  },
};
`);

    const context = await resolveExecutionContext({
      adapter: adapterPath,
      "connector-id": "tiktok-live",
      connect: "true",
      "unique-id": "adapter-user",
    });

    const runtime = createStreamingChatRuntime({ connectors: context.connectors });
    await runtime.start(context.runtimeConfig);

    const status = runtime.getStatus();
    expect(status.connectorState).toBe("connected");
    expect(status.roomId).toBe("adapter-room");

    await runtime.stop();
  });

  it("requires non-empty tiktok uniqueId when connect=true", async () => {
    await expect(resolveExecutionContext({
      "connector-id": "tiktok-live",
      connect: "true",
      "unique-id": "@",
    })).rejects.toThrow("Configuração inválida.");
  });
});
