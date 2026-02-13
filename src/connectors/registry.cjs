const { createTikTokLiveConnector } = require("./tiktok-live-connector.cjs");

function createConnectorRegistry(extraConnectors) {
  const map = new Map();
  const connectors = [
    createTikTokLiveConnector(),
    ...(Array.isArray(extraConnectors) ? extraConnectors : []),
  ];

  for (const definition of connectors) {
    if (!definition || typeof definition !== "object") {
      throw new Error("Connector definition precisa ser um objeto.");
    }

    const id = String(definition.id || "").trim();
    const platform = String(definition.platform || "").trim();
    if (!id) {
      throw new Error("Connector definition precisa de 'id'.");
    }
    if (!platform) {
      throw new Error(`Connector '${id}' precisa de 'platform'.`);
    }
    if (typeof definition.create !== "function") {
      throw new Error(`Connector '${id}' precisa de função 'create'.`);
    }

    map.set(id, definition);
  }

  return {
    get(id) {
      const key = String(id || "").trim();
      return key ? map.get(key) : undefined;
    },
    list() {
      return Array.from(map.values());
    },
  };
}

module.exports = {
  createConnectorRegistry,
};
