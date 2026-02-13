const {
  createStreamingChatRuntime,
  validateRuntimeConfig,
} = require("./runtime/create-streaming-chat-runtime.cjs");
const { createTikTokLiveConnector } = require("./connectors/tiktok-live-connector.cjs");

module.exports = {
  createStreamingChatRuntime,
  createTikTokLiveConnector,
  validateRuntimeConfig,
};
