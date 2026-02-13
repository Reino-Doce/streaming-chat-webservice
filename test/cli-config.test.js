// @vitest-environment node

import { describe, it, expect } from "vitest";
import cliConfigPackage from "../src/cli/config.cjs";

const { resolveVerbosity } = cliConfigPackage;

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
});
