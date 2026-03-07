// @vitest-environment node

import { describe, it, expect } from "vitest";
import cliConfigPackage from "../src/config.cjs";

const { resolveVerbosity, buildRuntimeConfig } = cliConfigPackage;

describe("cli config", () => {
  it("uses warn verbosity by default", () => {
    expect(resolveVerbosity({}, {})).toBe("warn");
  });

  it("accepts verbosity from config file", () => {
    expect(resolveVerbosity({ verbosity: "chat" }, {})).toBe("chat");
  });

  it("prefers --verbosity over config file", () => {
    expect(resolveVerbosity({ verbosity: "error" }, { verbosity: "debug" })).toBe("debug");
  });

  it("falls back to warn for invalid verbosity values", () => {
    expect(resolveVerbosity({ verbosity: "chat" }, { verbosity: "loud" })).toBe("warn");
  });

  it("uses default reconnectDelayOfflineMs when not configured", () => {
    const config = buildRuntimeConfig({}, {});
    expect(config.reconnectDelayOfflineMs).toBe(30000);
  });

  it("accepts reconnect-delay-offline-ms from CLI options", () => {
    const config = buildRuntimeConfig({}, { "reconnect-delay-offline-ms": "45000" });
    expect(config.reconnectDelayOfflineMs).toBe(45000);
  });

  it("clamps reconnect-delay-offline-ms to max value", () => {
    const config = buildRuntimeConfig({}, { "reconnect-delay-offline-ms": "999999" });
    expect(config.reconnectDelayOfflineMs).toBe(600000);
  });

  it("uses monitor=false by default", () => {
    const config = buildRuntimeConfig({}, {});
    expect(config.monitor).toBe(false);
  });

  it("accepts monitor from CLI options", () => {
    const config = buildRuntimeConfig({}, { monitor: "true" });
    expect(config.monitor).toBe(true);
  });

  it("uses uscp-sse/1 as default ws protocol", () => {
    const config = buildRuntimeConfig({}, {});
    expect(config.ws.protocol).toBe("uscp-sse/1");
  });

  it("maps removed json ws protocol option to uscp-sse/1", () => {
    const config = buildRuntimeConfig({}, { "ws-protocol": "json" });
    expect(config.ws.protocol).toBe("uscp-sse/1");
  });

  it("accepts connector verbose toggle from CLI options", () => {
    const config = buildRuntimeConfig({}, { verbose: "true" });
    expect(config.connectorConfig.verbose).toBe(true);
  });

  it("accepts connector verbose log path from CLI options", () => {
    const config = buildRuntimeConfig({}, { "verbose-log-path": "./logs/tiktok-live-connector.log" });
    expect(config.connectorConfig.verboseLogPath).toBe("./logs/tiktok-live-connector.log");
  });
});
