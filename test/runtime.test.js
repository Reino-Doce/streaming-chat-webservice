// @vitest-environment node

import WebSocket from "ws";
import { describe, it, expect, vi } from "vitest";
import streamingChatPackage from "../src/index.cjs";

const { createStreamingChatRuntime } = streamingChatPackage;
const { validateRuntimeConfig } = streamingChatPackage;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function waitForTransport(runtime, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = runtime.getStatus();
    if (status.wsRunning) {
      return;
    }
    await wait(25);
  }
  throw new Error("timeout waiting runtime transport to start");
}

function createMockConnectorHarness({ autoDisconnectMs = 0, autoDisconnectReason = "mock disconnect" } = {}) {
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
                reason: autoDisconnectReason,
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

function createFailingConnectorHarness({ errorMessage = "The requested user isn't online :(" } = {}) {
  let connectCount = 0;

  return {
    definition: {
      id: "failing-connector",
      platform: "tiktok",
      create() {
        return {
          async connect() {
            connectCount += 1;
            throw new Error(errorMessage);
          },
          async disconnect() {},
        };
      },
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

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function createSseReader(response) {
  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    throw new Error("SSE response body is not readable");
  }

  return {
    reader: body.getReader(),
    buffer: "",
    decoder: new TextDecoder(),
  };
}

async function readNextSseEvent(state, timeoutMs = 4000) {
  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const block = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);

      const trimmed = block.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;

      const event = {
        event: "",
        id: "",
        data: "",
      };

      for (const line of block.split("\n")) {
        if (!line.trim()) continue;
        if (line.startsWith(":")) continue;

        const separatorIndex = line.indexOf(":");
        if (separatorIndex < 0) continue;

        const field = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trimStart();

        if (field === "event") {
          event.event = value;
        } else if (field === "id") {
          event.id = value;
        } else if (field === "data") {
          event.data = event.data ? `${event.data}\n${value}` : value;
        }
      }

      return event;
    }

    const chunk = await Promise.race([
      state.reader.read(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timeout waiting SSE event")), timeoutMs);
      }),
    ]);

    if (chunk.done) {
      throw new Error("sse stream ended");
    }

    state.buffer += state.decoder.decode(chunk.value, { stream: true }).replace(/\r/g, "");
  }
}

async function closeSseReader(state) {
  try {
    await state.reader.cancel();
  } catch {}
}

async function waitForMatchingSseFrame(state, predicate, timeoutMs = 4000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
    let event = null;
    try {
      event = await readNextSseEvent(state, remaining);
    } catch (error) {
      if (String(error?.message || error).includes("timeout waiting SSE event")) {
        break;
      }
      throw error;
    }
    let frame = null;

    try {
      frame = JSON.parse(event.data);
    } catch {
      continue;
    }

    let matched = false;
    try {
      matched = predicate(event, frame);
    } catch {
      matched = false;
    }

    if (matched) {
      return {
        event,
        frame,
      };
    }
  }

  throw new Error("timeout waiting matching SSE frame");
}

describe("streaming chat runtime", () => {
  it("accepts neutral idle config during validation", () => {
    const validation = validateRuntimeConfig({});

    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.config.connectorId).toBe("");
    expect(validation.config.connect).toBe(false);
    expect(validation.config.monitor).toBe(false);
    expect(validation.config.ws.protocol).toBe("uscp-sse/1");
  });

  it("maps removed json protocol to uscp-sse/1", () => {
    const validation = validateRuntimeConfig({
      ws: {
        enabled: true,
        protocol: "json",
        token: "tok",
      },
    });

    expect(validation.ok).toBe(true);
    expect(validation.config.ws.protocol).toBe("uscp-sse/1");
  });

  it("rejects validation when connect=true and connectorId is empty", () => {
    const validation = validateRuntimeConfig({
      connect: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("connectorId é obrigatório quando connect=true ou monitor=true.");
  });

  it("rejects validation when monitor=true and connectorId is empty", () => {
    const validation = validateRuntimeConfig({
      monitor: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("connectorId é obrigatório quando connect=true ou monitor=true.");
  });

  it("rejects unknown explicit connectorId during validation", () => {
    const validation = validateRuntimeConfig({
      connectorId: "missing-connector",
      connect: false,
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("Connector 'missing-connector' não foi encontrado.");
  });

  it("accepts validation when connector is registered by host program", () => {
    const harness = createMockConnectorHarness();
    const validation = validateRuntimeConfig(
      {
        connectorId: "mock-connector",
        connect: true,
      },
      { connectors: [harness.definition] },
    );

    expect(validation.ok).toBe(true);
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

  it("uses offline reconnect delay when disconnect reason indicates user offline", async () => {
    const harness = createMockConnectorHarness({
      autoDisconnectMs: 30,
      autoDisconnectReason: "The requested user isn't online :(",
    });
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });

    await runtime.start({
      connectorId: "mock-connector",
      connectorConfig: {},
      connect: true,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 150,
      reconnectDelayOfflineMs: 1000,
      ws: {
        enabled: false,
        protocol: "moblin-xmpp",
        host: "127.0.0.1",
        port: nextPort(),
        token: "",
      },
      giftToSyntheticChat: true,
    });

    await wait(450);
    expect(harness.getConnectCount()).toBe(1);

    await wait(800);
    expect(harness.getConnectCount()).toBeGreaterThan(1);

    await runtime.stop();
  });

  it("does not throw on initial offline failure when monitor=true and retries in background", async () => {
    const harness = createFailingConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });

    await expect(runtime.start({
      connectorId: "failing-connector",
      connectorConfig: {},
      connect: false,
      monitor: true,
      reconnectOnDisconnect: false,
      reconnectDelayMs: 150,
      reconnectDelayOfflineMs: 1000,
      ws: {
        enabled: false,
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port: nextPort(),
        token: "",
      },
      giftToSyntheticChat: true,
    })).resolves.toMatchObject({
      connectorId: "failing-connector",
    });

    expect(runtime.getStatus().connectorState).toBe("reconnecting");

    await wait(450);
    expect(harness.getConnectCount()).toBe(1);

    await wait(800);
    expect(harness.getConnectCount()).toBeGreaterThan(1);

    await runtime.stop();
  });

  it("keeps initial connect failure fatal when connect=true and monitor=false", async () => {
    const harness = createFailingConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });

    await expect(runtime.start({
      connectorId: "failing-connector",
      connectorConfig: {},
      connect: true,
      monitor: false,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 150,
      reconnectDelayOfflineMs: 1000,
      ws: {
        enabled: false,
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port: nextPort(),
        token: "",
      },
      giftToSyntheticChat: true,
    })).rejects.toThrow("The requested user isn't online :(");

    await runtime.stop();
  });

  it("rejects unauthorized uscp control requests", async () => {
    const runtime = createStreamingChatRuntime();
    const port = nextPort();

    await runtime.start({
      connectorId: "",
      connectorConfig: {},
      connect: false,
      reconnectOnDisconnect: true,
      reconnectDelayMs: 1000,
      ws: {
        enabled: true,
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "secret",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe("auth.invalid_token");

    await runtime.stop();
  });

  it("creates uscp session and emits handshake-first stream", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "uscp-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("uscp-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });

    expect(createResponse.status).toBe(201);
    const session = await createResponse.json();
    expect(session.protocol).toBe("uscp-sse/1");
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId.length).toBeGreaterThan(0);

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer uscp-token",
        Accept: "text/event-stream",
      },
    });
    expect(streamResponse.status).toBe(200);

    const sse = createSseReader(streamResponse);
    const firstEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(firstEvent.data);

    expect(firstEvent.event).toBe("handshake");
    expect(handshake.o).toBe("h");
    expect(handshake.v).toBe("uscp-sse/1");

    harness.emit({
      type: "chat",
      platform: "mock",
      at: Date.now(),
      author: {
        username: "alice",
        displayName: "Alice",
      },
      message: "hello uscp",
    });

    const secondEvent = await readNextSseEvent(sse);
    const frame = JSON.parse(secondEvent.data);
    const typeById = new Map(handshake.typ);

    expect(frame.o).toBe("e");
    expect(frame.q).toBeGreaterThan(handshake.q);
    expect(typeById.get(frame.y)).toBe("chat.message");
    expect(frame.p.message_text).toBe("hello uscp");
    expect(frame.p.user_displayname).toBe("Alice");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("emits monitor.connected to uscp clients with source_room_id", async () => {
    const harness = createMockConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });
    const port = nextPort();

    await runtime.start({
      connectorId: "mock-connector",
      connectorConfig: {},
      connect: false,
      monitor: false,
      reconnectOnDisconnect: false,
      reconnectDelayMs: 1000,
      reconnectDelayOfflineMs: 1000,
      ws: {
        enabled: true,
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "monitor-connected-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("monitor-connected-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer monitor-connected-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    await runtime.update({
      monitor: true,
    });

    const { frame } = await waitForMatchingSseFrame(sse, (_event, candidate) => (
      candidate?.o === "e" &&
      typeById.get(candidate.y) === "system.upstream.event" &&
      candidate?.p?.upstream_event === "monitor.connected"
    ));

    expect(frame.p.state).toBe("connected");
    expect(frame.p.source_room_id).toBe("room-1");
    expect(frame.p.summary).toBe("Conectado ao chat. Sala: room-1.");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("emits a single monitor.offline event per offline cycle", async () => {
    const harness = createMockConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });
    const port = nextPort();

    await runtime.start({
      connectorId: "mock-connector",
      connectorConfig: {},
      connect: false,
      monitor: false,
      reconnectOnDisconnect: false,
      reconnectDelayMs: 1000,
      reconnectDelayOfflineMs: 5000,
      ws: {
        enabled: true,
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "monitor-offline-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("monitor-offline-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer monitor-offline-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    await runtime.update({
      monitor: true,
    });

    await waitForMatchingSseFrame(sse, (_event, candidate) => (
      candidate?.o === "e" &&
      typeById.get(candidate.y) === "system.upstream.event" &&
      candidate?.p?.upstream_event === "monitor.connected"
    ));

    harness.emit({
      type: "lifecycle",
      at: Date.now(),
      state: "disconnected",
      reason: "The requested user isn't online :(",
    });
    harness.emit({
      type: "lifecycle",
      at: Date.now(),
      state: "disconnected",
      reason: "The requested user isn't online :(",
    });

    const { frame } = await waitForMatchingSseFrame(sse, (_event, candidate) => (
      candidate?.o === "e" &&
      typeById.get(candidate.y) === "system.upstream.event" &&
      candidate?.p?.upstream_event === "monitor.offline"
    ));

    expect(frame.p.state).toBe("offline");
    expect(frame.p.reason).toBe("The requested user isn't online :(");
    expect(frame.p.source_room_id).toBe("room-1");

    await expect(waitForMatchingSseFrame(sse, (_event, candidate) => (
      candidate?.o === "e" &&
      typeById.get(candidate.y) === "system.upstream.event" &&
      candidate?.p?.upstream_event === "monitor.offline"
    ), 1200)).rejects.toThrow("timeout waiting matching SSE frame");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("emits monitor.disconnected instead of monitor.offline for non-offline reasons", async () => {
    const harness = createMockConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });
    const port = nextPort();

    await runtime.start({
      connectorId: "mock-connector",
      connectorConfig: {},
      connect: false,
      monitor: false,
      reconnectOnDisconnect: false,
      reconnectDelayMs: 5000,
      reconnectDelayOfflineMs: 5000,
      ws: {
        enabled: true,
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "monitor-disconnected-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("monitor-disconnected-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer monitor-disconnected-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    await runtime.update({
      monitor: true,
    });

    await waitForMatchingSseFrame(sse, (_event, candidate) => (
      candidate?.o === "e" &&
      typeById.get(candidate.y) === "system.upstream.event" &&
      candidate?.p?.upstream_event === "monitor.connected"
    ));

    harness.emit({
      type: "lifecycle",
      at: Date.now(),
      state: "disconnected",
      reason: "socket closed unexpectedly",
    });

    const { frame } = await waitForMatchingSseFrame(sse, (_event, candidate) => (
      candidate?.o === "e" &&
      typeById.get(candidate.y) === "system.upstream.event" &&
      candidate?.p?.upstream_event === "monitor.disconnected"
    ));

    expect(frame.p.state).toBe("disconnected");
    expect(frame.p.reason).toBe("socket closed unexpectedly");
    expect(frame.p.source_room_id).toBe("room-1");

    await expect(waitForMatchingSseFrame(sse, (_event, candidate) => (
      candidate?.o === "e" &&
      typeById.get(candidate.y) === "system.upstream.event" &&
      candidate?.p?.upstream_event === "monitor.offline"
    ), 1200)).rejects.toThrow("timeout waiting matching SSE frame");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("normalizes synthetic protocol chat.message gifts and preserves normal chat.message", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "normalize-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("normalize-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer normalize-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      author: {
        username: "donor-1",
      },
      typeCode: "chat.message",
      payload: {
        message_text: "[GIFT] rose (5 diamonds)",
        user_displayname: "Donor One",
        user_image_id: "https://cdn.example/avatar-donor.webp",
        source_message_id: "gift-msg-1",
        source_room_id: "room-99",
      },
    });

    const normalizedGiftEvent = await readNextSseEvent(sse);
    const normalizedGiftFrame = JSON.parse(normalizedGiftEvent.data);
    expect(typeById.get(normalizedGiftFrame.y)).toBe("monetization.donation.gift");
    expect(normalizedGiftFrame.p.gift_id).toBe("rose");
    expect(normalizedGiftFrame.p.donation_value).toBe("5 diamonds");
    expect(normalizedGiftFrame.p.user_displayname).toBe("Donor One");
    expect(normalizedGiftFrame.p.user_image_id).toBe("https://cdn.example/avatar-donor.webp");
    expect(normalizedGiftFrame.p.source_message_id).toBe("gift-msg-1");
    expect(normalizedGiftFrame.p.source_room_id).toBe("room-99");

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      author: {
        username: "viewer-1",
      },
      typeCode: "chat.message",
      payload: {
        message_text: "regular chat line",
        user_displayname: "Viewer One",
        source_message_id: "chat-msg-1",
      },
    });

    const regularChatEvent = await readNextSseEvent(sse);
    const regularChatFrame = JSON.parse(regularChatEvent.data);
    expect(typeById.get(regularChatFrame.y)).toBe("chat.message");
    expect(regularChatFrame.p.message_text).toBe("regular chat line");
    expect(regularChatFrame.p.user_displayname).toBe("Viewer One");
    expect(regularChatFrame.p.source_message_id).toBe("chat-msg-1");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("preserves user_image_id for like/share protocol payloads", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "avatar-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("avatar-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer avatar-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      author: {
        username: "viewer-like",
      },
      typeCode: "interaction.reaction.like",
      payload: {
        reaction_type: "like",
        reaction_amount: 2,
        user_displayname: "Viewer Like",
        user_image_id: "https://cdn.example/avatar-like.webp",
      },
    });

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      author: {
        username: "viewer-share",
      },
      typeCode: "interaction.reaction.share",
      payload: {
        reaction_type: "share",
        reaction_amount: 1,
        user_displayname: "Viewer Share",
        user_image_id: "https://cdn.example/avatar-share.webp",
      },
    });

    const likeEvent = await readNextSseEvent(sse);
    const likeFrame = JSON.parse(likeEvent.data);
    expect(typeById.get(likeFrame.y)).toBe("interaction.reaction.like");
    expect(likeFrame.p.user_image_id).toBe("https://cdn.example/avatar-like.webp");

    const shareEvent = await readNextSseEvent(sse);
    const shareFrame = JSON.parse(shareEvent.data);
    expect(typeById.get(shareFrame.y)).toBe("interaction.reaction.share");
    expect(shareFrame.p.user_image_id).toBe("https://cdn.example/avatar-share.webp");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("falls back to system.upstream.event when gift cannot satisfy canonical payload", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "gift-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("gift-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer gift-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    harness.emit({
      type: "gift",
      platform: "mock",
      at: Date.now(),
      author: {
        username: "donor",
      },
      renderedText: "gift event without raw gift details",
      raw: {},
    });

    const event = await readNextSseEvent(sse);
    const frame = JSON.parse(event.data);
    const typeCode = typeById.get(frame.y);

    expect(typeCode).toBe("system.upstream.event");
    expect(frame.p.upstream).toBe("streaming-chat-runtime");
    expect(frame.p.upstream_event).toBe("gift");
    expect(Object.prototype.hasOwnProperty.call(frame.p, "raw")).toBe(false);

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("drops unmapped tiktok events instead of broadcasting fallback frames", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "upstream-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("upstream-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer upstream-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    expect(JSON.parse(handshakeEvent.data).o).toBe("h");

    harness.emit({
      type: "tiktok-live.webcast.member",
      platform: "tiktok",
      at: Date.now(),
      raw: {
        uniqueId: "viewer-1",
      },
    });

    await expect(readNextSseEvent(sse, 1200)).rejects.toThrow("timeout waiting SSE event");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("streams protocol events using canonical type dictionary", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "protocol-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("protocol-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer protocol-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      author: {
        username: "rival1",
      },
      typeCode: "competition.link_mic_battle.started",
      payload: {
        battle_id: "battle-1",
        battle_action: 4,
        source_message_id: "msg-1",
      },
    });

    const event = await readNextSseEvent(sse);
    const frame = JSON.parse(event.data);
    expect(typeById.get(frame.y)).toBe("competition.link_mic_battle.started");
    expect(frame.p.battle_id).toBe("battle-1");
    expect(frame.p.battle_action).toBe(4);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      typeCode: "competition.link_mic_battle.started",
      payload: {
        battle_id: "battle-2",
      },
    });

    await expect(readNextSseEvent(sse, 1200)).rejects.toThrow("timeout waiting SSE event");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("streams audience fan/join protocol events with the updated canonical types", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "interactions-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("interactions-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer interactions-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      typeCode: "audience.fan_club.fan_level",
      payload: {
        fan_level: 2,
        notice_type: "upgrade",
        total_link_mic_fan_ticket: 370,
        top_user_fan_ticket: 120,
        top_user_id: "7001",
        top_user_nickname: "Top Fan",
        fan_ticket_users: [
          {
            user_id: "7001",
            fan_ticket: 120,
            match_rank: 1,
          },
        ],
        user_displayname: "Fan User",
      },
    });

    const fanEvent = await readNextSseEvent(sse);
    const fanFrame = JSON.parse(fanEvent.data);
    expect(typeById.get(fanFrame.y)).toBe("audience.fan_club.fan_level");
    expect(fanFrame.p.fan_level).toBe(2);
    expect(fanFrame.p.user_displayname).toBe("Fan User");
    expect(fanFrame.p.top_user_id).toBe("Fan User");
    expect(fanFrame.p.fan_ticket_users).toEqual([
      {
        user_id: "7001",
        fan_ticket: 120,
        match_rank: 1,
      },
    ]);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      typeCode: "audience.room_join",
      payload: {
        join_event: "barrage",
        msg_type: 10,
        sub_type: "super_fan_upgrade",
        content: "joined",
        duration_ms: 5000,
        scene: 0,
        barrage_user_id: "7198647403678761989",
        barrage_user_unique_id: "3esmit",
        barrage_user_displayname: "Join User",
        fan_level_current_grade: 23,
        user_level_current_grade: 31,
        level_value: "23",
        user_displayname: "Join User",
      },
    });

    const joinEvent = await readNextSseEvent(sse);
    const joinFrame = JSON.parse(joinEvent.data);
    expect(typeById.get(joinFrame.y)).toBe("audience.room_join");
    expect(joinFrame.p.join_event).toBe("barrage");
    expect(joinFrame.p.user_displayname).toBe("Join User");
    expect(joinFrame.p.barrage_user_displayname).toBe("Join User");
    expect(joinFrame.p.level_value).toBe("23");

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      typeCode: "competition.link.message.updated",
      payload: {
        message_type: 20,
        scene: 4,
        linker_id: "7608284260952703248",
        expire_timestamp: 0,
        linked_users: [
          {
            user_id: "6619805802554064902",
            unique_id: "oieshira",
            nickname: "Shira",
            link_status: 1,
            user_position: 0,
            link_type: 0,
          },
        ],
      },
    });

    const linkMessageEvent = await readNextSseEvent(sse);
    const linkMessageFrame = JSON.parse(linkMessageEvent.data);
    expect(typeById.get(linkMessageFrame.y)).toBe("competition.link.message.updated");
    expect(linkMessageFrame.p.linked_users).toEqual([
      {
        user_id: "6619805802554064902",
        unique_id: "oieshira",
        nickname: "Shira",
        link_status: 1,
        user_position: 0,
        link_type: 0,
      },
    ]);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      typeCode: "competition.link.layer.updated",
      payload: {
        message_type: 9,
        channel_id: "7608284260952703248",
        scene: 4,
        source_type: 8,
        leave_user_id: "6708781174556279813",
        leave_reason: "10003",
        kickout_user_id: "700100200300",
        kickout_reason: 2,
        cohost_user_infos: [
          {
            user_id: "7198647403678761989",
            unique_id: "3esmit",
            nickname: "Ricardo",
            change_type: 2,
            link_status: 3,
            user_position: 0,
          },
        ],
      },
    });

    const linkLayerEvent = await readNextSseEvent(sse);
    const linkLayerFrame = JSON.parse(linkLayerEvent.data);
    expect(typeById.get(linkLayerFrame.y)).toBe("competition.link.layer.updated");
    expect(linkLayerFrame.p.leave_user_id).toBe("6708781174556279813");
    expect(linkLayerFrame.p.cohost_user_infos).toEqual([
      {
        user_id: "7198647403678761989",
        unique_id: "3esmit",
        nickname: "Ricardo",
        change_type: 2,
        link_status: 3,
        user_position: 0,
      },
    ]);

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("maps known numeric user ids to usernames in subsequent protocol payloads", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "id-map-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("id-map-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer id-map-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      author: {
        id: "123456",
        username: "alice",
        displayName: "Alice",
      },
      typeCode: "chat.message",
      payload: {
        message_text: "hello everyone",
        source_message_id: "msg-hello-1",
      },
    });

    const chatEvent = await readNextSseEvent(sse);
    const chatFrame = JSON.parse(chatEvent.data);
    expect(typeById.get(chatFrame.y)).toBe("chat.message");

    harness.emit({
      type: "protocol",
      platform: "tiktok",
      at: Date.now(),
      typeCode: "competition.link_mic_battle.points.updated",
      payload: {
        battle_id: "battle-name-map-1",
        battle_status: 1,
        channel_id: "channel-1",
        from_user_id: "123456",
        gift_count: 2,
        battle_items: {
          "7333268400971826182": {
            anchor_id_str: "7333268400971826182",
            host_score: 686,
            user_army: [
              { user_id_str: "6893614668540871686", nickname: "Ana", score: 34 },
            ],
          },
          "7175799697994269698": {
            anchor_id_str: "7175799697994269698",
            host_score: 730,
            user_army: [
              { user_id_str: "7412302855266288641", nickname: "Kung", score: 69 },
            ],
          },
        },
      },
    });

    const mappedEvent = await readNextSseEvent(sse);
    const mappedFrame = JSON.parse(mappedEvent.data);
    expect(typeById.get(mappedFrame.y)).toBe("competition.link_mic_battle.points.updated");
    expect(mappedFrame.p.from_user_id).toBe("Alice");
    expect(mappedFrame.p.battle_items).toEqual({
      "7333268400971826182": {
        anchor_id_str: "7333268400971826182",
        host_score: 686,
        user_army: [
          { user_id_str: "6893614668540871686", nickname: "Ana", score: 34 },
        ],
      },
      "7175799697994269698": {
        anchor_id_str: "7175799697994269698",
        host_score: 730,
        user_army: [
          { user_id_str: "7412302855266288641", nickname: "Kung", score: 69 },
        ],
      },
    });

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("drops legacy barrage/fan_ticket protocol types and logs payload context", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = createMockConnectorHarness();
    const runtime = createStreamingChatRuntime({ connectors: [harness.definition] });
    const port = nextPort();

    try {
      await runtime.start({
        connectorId: "mock-connector",
        connectorConfig: {},
        connect: true,
        reconnectOnDisconnect: true,
        reconnectDelayMs: 1000,
        ws: {
          enabled: true,
          protocol: "uscp-sse/1",
          host: "127.0.0.1",
          port,
          token: "legacy-drop-token",
        },
        giftToSyntheticChat: true,
      });

      await waitForTransport(runtime);

      const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: "POST",
        headers: authHeaders("legacy-drop-token"),
        body: JSON.stringify({
          protocol: "uscp-sse/1",
        }),
      });
      const session = await createResponse.json();

      const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
        headers: {
          Authorization: "Bearer legacy-drop-token",
          Accept: "text/event-stream",
        },
      });
      const sse = createSseReader(streamResponse);
      const handshakeEvent = await readNextSseEvent(sse);
      expect(JSON.parse(handshakeEvent.data).o).toBe("h");

      harness.emit({
        type: "protocol",
        platform: "tiktok",
        at: Date.now(),
        typeCode: "competition.link_mic.fan_ticket.updated",
        payload: {
          notice_type: "updated",
          fan_level: 2,
        },
      });

      await expect(readNextSseEvent(sse, 1200)).rejects.toThrow("timeout waiting SSE event");

      harness.emit({
        type: "protocol",
        platform: "tiktok",
        at: Date.now(),
        typeCode: "interaction.barrage.announced",
        payload: {
          barrage_event: "join",
          content: "legacy barrage",
        },
      });

      await expect(readNextSseEvent(sse, 1200)).rejects.toThrow("timeout waiting SSE event");

      const warnedTypeCodes = warnSpy.mock.calls
        .map((call) => call?.[1]?.typeCode)
        .filter(Boolean);
      expect(warnedTypeCodes).toContain("competition.link_mic.fan_ticket.updated");
      expect(warnedTypeCodes).toContain("interaction.barrage.announced");

      const fanDrop = warnSpy.mock.calls.find(
        (call) => call?.[1]?.typeCode === "competition.link_mic.fan_ticket.updated",
      );
      expect(fanDrop?.[1]?.payload?.fan_level).toBe(2);

      await closeSseReader(sse);
    } finally {
      warnSpy.mockRestore();
      await runtime.stop();
    }
  });

  it("applies actor exclude filter precedence for uscp stream", async () => {
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
        protocol: "uscp-sse/1",
        host: "127.0.0.1",
        port,
        token: "filter-token",
      },
      giftToSyntheticChat: true,
    });

    await waitForTransport(runtime);

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: authHeaders("filter-token"),
      body: JSON.stringify({
        protocol: "uscp-sse/1",
        filters: {
          actors: {
            include: [],
            exclude: ["handle:bot"],
          },
        },
      }),
    });
    const session = await createResponse.json();

    const streamResponse = await fetch(`http://127.0.0.1:${port}${session.streamUrl}`, {
      headers: {
        Authorization: "Bearer filter-token",
        Accept: "text/event-stream",
      },
    });
    const sse = createSseReader(streamResponse);
    const handshakeEvent = await readNextSseEvent(sse);
    const handshake = JSON.parse(handshakeEvent.data);
    const typeById = new Map(handshake.typ);

    harness.emit({
      type: "chat",
      platform: "mock",
      at: Date.now(),
      author: {
        username: "bot",
        displayName: "Bot",
      },
      message: "should be filtered",
    });

    harness.emit({
      type: "chat",
      platform: "mock",
      at: Date.now(),
      author: {
        username: "alice",
        displayName: "Alice",
      },
      message: "should pass",
    });

    let matchedFrame = null;
    for (let i = 0; i < 6; i += 1) {
      const event = await readNextSseEvent(sse, 5000);
      const frame = JSON.parse(event.data);
      if (frame.o !== "e") continue;
      if (typeById.get(frame.y) !== "chat.message") continue;
      matchedFrame = frame;
      break;
    }

    expect(matchedFrame).not.toBeNull();
    expect(matchedFrame.p.message_text).toBe("should pass");

    await closeSseReader(sse);
    await runtime.stop();
  });

  it("enforces token in moblin xmpp mode", async () => {
    const runtime = createStreamingChatRuntime();
    const port = nextPort();

    await runtime.start({
      connectorId: "",
      connectorConfig: {},
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
