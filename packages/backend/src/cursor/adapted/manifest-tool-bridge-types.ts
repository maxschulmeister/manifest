import type { McpServerConfig } from '@cursor/sdk';

export interface ManifestMcpInputSchema {
  type: 'object';
  properties?: Record<string, object>;
  required?: string[];
  [key: string]: unknown;
}

export interface ManifestBridgeToolDefinition {
  agentToolName: string;
  mcpToolName: string;
  description: string;
  inputSchema: ManifestMcpInputSchema;
}

export interface ManifestToolBridgeSnapshot {
  tools: ManifestBridgeToolDefinition[];
  mcpToolNameToAgentToolName: ReadonlyMap<string, string>;
  agentToolNameToMcpToolName: ReadonlyMap<string, string>;
}

export interface ManifestBridgeToolRequest {
  runId: string;
  bridgeCallId: string;
  cursorMcpCallId?: string;
  manifestToolCallId: string;
  agentToolName: string;
  mcpToolName: string;
  args: Record<string, unknown>;
}

export interface ManifestToolBridgeRun {
  id: string;
  enabled: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  snapshot: ManifestToolBridgeSnapshot;
  takeQueuedToolRequests(): ManifestBridgeToolRequest[];
  resolveToolResults(
    toolResults: ReadonlyArray<{ toolCallId: string; content: string; isError?: boolean }>,
  ): void;
  hasPendingManifestToolCallId(manifestToolCallId: string): boolean;
  hasPendingToolCalls(): boolean;
  isBridgeMcpToolCall(toolCall: unknown): boolean;
  setOnToolRequest(handler?: (request: ManifestBridgeToolRequest) => void): void;
  cancel(reason: string): void;
  dispose(): Promise<void>;
}

export interface ManifestToolBridgeRunOptions {
  snapshot: ManifestToolBridgeSnapshot;
  onToolRequest?: (request: ManifestBridgeToolRequest) => void;
}

export interface ManifestToolBridge {
  createRun(options: ManifestToolBridgeRunOptions): Promise<ManifestToolBridgeRun>;
  disposeAll(reason?: string): Promise<void>;
}
