// @vitest-environment node

import WebSocket from "ws";
import { describe, it, expect } from "vitest";
import streamingChatPackage from "../src/index.cjs";

const { createStreamingChatRuntime } = streamingChatPackage;
const { validateRuntimeConfig } = streamingChatPackage;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function createMockConnectorHarness({ autoDisconnectMs = 0 } = {}) {
  let emitFn = null;
  let connectCount = 0;

  const definition = {
    id: "mock-connector",
    platform: "mock",
    create() {
      return {
        async connect(_config, emit) {
          connectCount += 1;
          emitFn = emit;

          emit({
            type: "lifecycle",
            at: Date.now(),
            state: "connected",
            roomId: "room-1",
          });

          if (autoDisconnectMs > 0) {
            setTimeout(() => {
              if (!emitFn) return;
              emitFn({
                type: "lifecycle",
                at: Date.now(),
                state: "disconnected",
                reason: "mock disconnect",
              });
            }, autoDisconnectMs);
          }
        },
        async disconnect() {
          emitFn = null;
        },
      };
    },
  };

  return {
    definition,
    emit(event) {
      if (emitFn) emitFn(event);
    },
    getConnectCount() {
      return connectCount;
    },
  };
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let timeout = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      ws.removeListener("message", handleMessage);
      ws.removeListener("error", handleError);
      ws.removeListener("close", handleClose);
    };

    const handleMessage = (raw) => {
      const text = String(raw ?? "");
      let matched = false;
      try {
        matched = predicate(text);
      } catch {
        matched = false;
      }

      if (!matched) return;
      cleanup();
      resolve(text);
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    const handleClose = () => {
      cleanup();
      reject(new Error("socket closed before expected message"));
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting websocket message"));
    }, timeoutMs);

    ws.on("message", handleMessage);
    ws.on("error", handleError);
    ws.on("close", handleClose);
  });
}

describe("streaming chat runtime", () => {
  it("normalizes tiktok uniqueId by stripping leading @ during validation", () => {
    const validation = validateRuntimeConfig({
      connectorId: "tiktok-live",
      connectorConfig: {
        uniqueId: "@@alice",
      },
      connect: true,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 1000,
      ws: {
        enabled: false,
        protocol: "moblin-xmpp",
        host: "127.0.0.1",
        port: 5443,
        token: "",
      },
      giftToSyntheticChat: true,
    });

    expect(validation.ok).toBe(true);
    expect(validation.config.connectorConfig.uniqueId).toBe("alice");
  });

  it("rejects tiktok uniqueId that becomes empty after stripping @", () => {
    const validation = validateRuntimeConfig({
      connectorId: "tiktok-live",
      connectorConfig: {
        uniqueId: "@",
      },
      connect: true,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 1000,
      ws: {
        enabled: false,
        protocol: "moblin-xmpp",
        host: "127.0.0.1",
        port: 5443,
        token: "",
      },
      giftToSyntheticChat: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("uniqueId do TikTok é obrigatório quando connect=true.");
  });

  it("reconnects connector after disconnect", async () => {
    const harness = createMockConnectorHarness({ autoDisconnectMs: 30 });
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });

    await runtime.start({
      connectorId: "mock-connector",
      connectorConfig: {},
      connect: true,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 1000,
      ws: {
        enabled: false,
        protocol: "moblin-xmpp",
        host: "127.0.0.1",
        port: nextPort(),
        token: "",
      },
      giftToSyntheticChat: true,
    });

    await wait(1300);
    expect(harness.getConnectCount()).toBeGreaterThan(1);

    await runtime.stop();
  });

  it("broadcasts chat in json ws mode", async () => {
    const harness = createMockConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });
    const port = nextPort();

    await runtime.start({
      connectorId: "mock-connector",
      connectorConfig: {},
      connect: true,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 1000,
      ws: {
        enabled: true,
        protocol: "json",
        host: "127.0.0.1",
        port,
        token: "json-token",
      },
      giftToSyntheticChat: true,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=json-token`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const chatPromise = waitForMessage(ws, (text) => {
      try {
        const parsed = JSON.parse(text);
        return parsed.type === "chat" && parsed.message === "hello json";
      } catch {
        return false;
      }
    });

    harness.emit({
      type: "chat",
      platform: "mock",
      at: Date.now(),
      author: {
        effectiveName: "alice",
      },
      message: "hello json",
    });

    const chatRaw = await chatPromise;
    const parsed = JSON.parse(chatRaw);

    expect(parsed.type).toBe("chat");
    expect(parsed.message).toBe("hello json");
    expect(parsed.author.effectiveName).toBe("alice");

    ws.close();
    await runtime.stop();
  });

  it("enforces token in moblin xmpp mode", async () => {
    const runtime = createStreamingChatRuntime();
    const port = nextPort();

    await runtime.start({
      connectorId: "tiktok-live",
      connectorConfig: {
        uniqueId: "",
      },
      connect: false,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 1000,
      ws: {
        enabled: true,
        protocol: "moblin-xmpp",
        host: "127.0.0.1",
        port,
        token: "secret",
      },
      giftToSyntheticChat: true,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, "xmpp");
    const closeCode = await new Promise((resolve, reject) => {
      ws.once("close", (code) => resolve(code));
      ws.once("error", reject);
    });

    expect(closeCode).toBe(1008);

    await runtime.stop();
  });

  it("keeps moblin xmpp handshake compatibility", async () => {
    const harness = createMockConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });
    const port = nextPort();

    await runtime.start({
      connectorId: "mock-connector",
      connectorConfig: {},
      connect: true,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 1000,
      ws: {
        enabled: true,
        protocol: "moblin-xmpp",
        host: "127.0.0.1",
        port,
        token: "xmpp-token",
      },
      giftToSyntheticChat: true,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=xmpp-token`, "xmpp");
    const featuresPromise = waitForMessage(ws, (text) => text.toLowerCase().includes("<features"));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const features = await featuresPromise;
    expect(features.toLowerCase()).toContain("<features");

    ws.send('<auth mechanism="PLAIN">dock</auth>');
    await waitForMessage(ws, (text) => text.toLowerCase().includes("<success"));

    ws.send("<iq><bind/></iq>");
    await waitForMessage(ws, (text) => text.toLowerCase().includes("<iq") && text.toLowerCase().includes("<bind"));

    const chatFramePromise = waitForMessage(ws, (text) => text.toLowerCase().includes("<message"));

    harness.emit({
      type: "chat",
      platform: "tiktok",
      at: Date.now(),
      author: {
        effectiveName: "bob",
      },
      message: "hello xmpp",
    });

    const chatFrame = await chatFramePromise;
    expect(chatFrame).toContain("hello xmpp");
    expect(chatFrame).toContain("tiktok/bob");

    ws.close();
    await runtime.stop();
  });
});
