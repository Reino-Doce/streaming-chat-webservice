import cjsModule from "./src/index.cjs";

export const {
  createStreamingChatRuntime,
  createTikTokLiveConnector,
  validateRuntimeConfig,
} = cjsModule;

export default cjsModule;
