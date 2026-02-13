// @vitest-environment node

import { describe, it, expect } from "vitest";
import cliConfigPackage from "../src/cli/config.cjs";

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
});
