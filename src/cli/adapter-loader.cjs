const path = require("path");

function isPathReference(value) {
  if (!value) return false;
  const text = String(value);

  return (
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

function normalizeConnectorDefinition(candidate) {
  const definition = candidate && typeof candidate === "object"
    ? (candidate.default || candidate.connector || candidate)
    : null;

  if (!definition || typeof definition !== "object") {
    throw new Error("Adapter não exporta um connector definition válido.");
  }

  if (typeof definition.id !== "string" || !definition.id.trim()) {
    throw new Error("Adapter precisa exportar 'id'.");
  }

  if (typeof definition.platform !== "string" || !definition.platform.trim()) {
    throw new Error("Adapter precisa exportar 'platform'.");
  }

  if (typeof definition.create !== "function") {
    throw new Error("Adapter precisa exportar função 'create'.");
  }

  return definition;
}

function loadAdapter(adapterRef, cwd = process.cwd()) {
  if (!adapterRef) return null;

  let loaded = null;
  if (isPathReference(adapterRef)) {
    const resolvedPath = path.isAbsolute(adapterRef)
      ? adapterRef
      : path.resolve(cwd, adapterRef);
    loaded = require(resolvedPath);
  } else {
    loaded = require(adapterRef);
  }

  return normalizeConnectorDefinition(loaded);
}

module.exports = {
  loadAdapter,
};
