export type WsProtocol = "moblin-xmpp" | "json";

export type AuthorIdentity = {
  id?: string;
  username?: string;
  displayName?: string;
  effectiveName: string;
};

export type StreamingEvent =
  | {
      type: "chat";
      platform: string;
      at: number;
      author: AuthorIdentity;
      message: string;
      raw?: unknown;
    }
  | {
      type: "gift";
      platform: string;
      at: number;
      author: AuthorIdentity;
      renderedText: string;
      raw?: unknown;
    }
  | {
      type: "lifecycle";
      at: number;
      state: "connecting" | "connected" | "reconnecting" | "disconnected";
      roomId?: string | null;
      reason?: string;
    }
  | {
      type: "error";
      at: number;
      message: string;
      fatal: boolean;
      raw?: unknown;
    };

export interface StreamingConnectorInstance {
  connect(config: unknown, emit: (event: StreamingEvent) => void): Promise<void>;
  disconnect(): Promise<void>;
}

export interface StreamingConnectorDefinition {
  id: string;
  platform: string;
  create(): StreamingConnectorInstance;
}

export type RuntimeConfig = {
  connectorId: string;
  connectorConfig: Record<string, unknown>;
  connect: boolean;
  reconnectOnDisconnect: boolean;
  reconnectDelayMs: number;
  reconnectDelayOfflineMs: number;
  ws: {
    enabled: boolean;
    protocol: WsProtocol;
    host: string;
    port: number;
    token: string;
  };
  giftToSyntheticChat: boolean;
};

export type RuntimeStatus = {
  connectorId: string;
  connectorState: "idle" | "connecting" | "connected" | "reconnecting";
  roomId: string | null;
  lastError: string;
  totalChatCount: number;
  totalGiftCount: number;
  wsRunning: boolean;
  wsClientCount: number;
  wsLastError: string;
};

export interface StreamingChatRuntime {
  start(config: RuntimeConfig): Promise<RuntimeStatus>;
  update(configPatch: Partial<RuntimeConfig>): Promise<RuntimeStatus>;
  stop(): Promise<RuntimeStatus>;
  getStatus(): RuntimeStatus;
  onEvent(listener: (event: StreamingEvent) => void): () => void;
  onStatus(listener: (status: RuntimeStatus) => void): () => void;
}

export type RuntimeValidation = {
  ok: boolean;
  errors: string[];
  config: RuntimeConfig;
};

export function createStreamingChatRuntime(args?: {
  connectors?: StreamingConnectorDefinition[];
}): StreamingChatRuntime;

export function createTikTokLiveConnector(): StreamingConnectorDefinition;

export function validateRuntimeConfig(
  rawConfig: Partial<RuntimeConfig>,
  args?: { connectors?: StreamingConnectorDefinition[] },
): RuntimeValidation;
