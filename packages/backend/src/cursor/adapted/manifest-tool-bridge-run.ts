/**
 * Adapted from pi-cursor-sdk cursor-pi-tool-bridge-run.ts (MIT). See ATTRIBUTION.md.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServerConfig } from '@cursor/sdk';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  MANIFEST_MCP_ENDPOINT_ROOT,
  MANIFEST_MCP_SERVER_NAME,
} from './manifest-tool-bridge-constants';
import type {
  ManifestBridgeToolRequest,
  ManifestToolBridgeRun,
  ManifestToolBridgeRunOptions,
  ManifestToolBridgeSnapshot,
} from './manifest-tool-bridge-types';
import {
  containsKnownMcpToolName,
  convertToolContentToMcpContent,
  getStringField,
  isRecord,
  normalizeMcpArgs,
  snapshotToolToMcpTool,
  waitForProtocolFlush,
} from './manifest-tool-bridge-mcp';

export interface ManifestToolBridgeRunHost {
  registerRun(pathname: string, run: ManifestToolBridgeRunImpl): Promise<string>;
  unregisterRun(pathname: string, run: ManifestToolBridgeRunImpl): Promise<void>;
}

const MCP_SERVER_VERSION = '0.1.0';

interface PendingBridgeCall {
  request: ManifestBridgeToolRequest;
  resolve: (result: CallToolResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

export class ManifestToolBridgeRunImpl implements ManifestToolBridgeRun {
  readonly id: string;
  readonly enabled: boolean;
  readonly snapshot: ManifestToolBridgeSnapshot;
  mcpServers?: Record<string, McpServerConfig>;

  private readonly registry: ManifestToolBridgeRunHost;
  private readonly endpointPath: string;
  private readonly knownMcpToolNames: ReadonlySet<string>;
  private readonly knownCursorMcpCallIds = new Set<string>();
  private readonly queuedRequests: ManifestBridgeToolRequest[] = [];
  private readonly pendingByManifestToolCallId = new Map<string, PendingBridgeCall>();
  private readonly pendingByBridgeCallId = new Map<string, PendingBridgeCall>();
  private readonly pendingByCursorMcpCallId = new Map<string, PendingBridgeCall>();
  private onToolRequest?: (request: ManifestBridgeToolRequest) => void;
  private liveRunHandlerDetached = false;
  private mcpServer?: McpProtocolServer;
  private mcpTransport?: StreamableHTTPServerTransport;
  private toolCallCounter = 0;
  private disposed = false;

  constructor(
    registry: ManifestToolBridgeRunHost,
    snapshot: ManifestToolBridgeSnapshot,
    enabled: boolean,
    options: ManifestToolBridgeRunOptions = { snapshot },
  ) {
    this.registry = registry;
    this.snapshot = snapshot;
    this.enabled = enabled;
    this.onToolRequest = options.onToolRequest;
    this.id = `manifest-bridge-run-${randomUUID()}`;
    this.endpointPath = `${MANIFEST_MCP_ENDPOINT_ROOT}/${randomUUID()}/mcp`;
    this.knownMcpToolNames = new Set(snapshot.tools.map((tool) => tool.mcpToolName));
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    await this.createMcpServer();
    const endpointUrl = await this.registry.registerRun(this.endpointPath, this);
    this.mcpServers = { [MANIFEST_MCP_SERVER_NAME]: { type: 'http', url: endpointUrl } };
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.disposed || !this.mcpTransport) {
      res
        .writeHead(410, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Manifest tool bridge run is disposed' }));
      return;
    }
    await this.mcpTransport.handleRequest(req, res);
  }

  takeQueuedToolRequests(): ManifestBridgeToolRequest[] {
    return this.queuedRequests.splice(0);
  }

  setOnToolRequest(handler?: (request: ManifestBridgeToolRequest) => void): void {
    if (!handler) {
      this.liveRunHandlerDetached = true;
      this.rejectQueuedToolRequestsWithoutHandler('Manifest tool bridge has no active live run');
    } else {
      this.liveRunHandlerDetached = false;
    }
    this.onToolRequest = handler;
    if (handler) {
      for (const request of this.queuedRequests.splice(0)) {
        const pending = this.pendingByManifestToolCallId.get(request.manifestToolCallId);
        if (pending) this.dispatchPendingToolRequest(pending, handler);
      }
    }
  }

  resolveToolResults(
    toolResults: ReadonlyArray<{ toolCallId: string; content: string; isError?: boolean }>,
  ): void {
    for (const toolResult of toolResults) {
      const pending = this.pendingByManifestToolCallId.get(toolResult.toolCallId);
      if (!pending || pending.settled) continue;
      this.resolvePending(pending, {
        content: convertToolContentToMcpContent(toolResult.content),
        isError: toolResult.isError || undefined,
      });
    }
  }

  hasPendingManifestToolCallId(manifestToolCallId: string): boolean {
    return this.pendingByManifestToolCallId.has(manifestToolCallId);
  }

  hasPendingToolCalls(): boolean {
    return this.pendingByManifestToolCallId.size > 0;
  }

  cancel(reason: string): void {
    const error = new Error(reason);
    this.queuedRequests.splice(0);
    for (const pending of [...this.pendingByBridgeCallId.values()]) {
      this.rejectPending(pending, error, 'cancelled');
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel('Manifest tool bridge run disposed');
    await waitForProtocolFlush();
    await Promise.allSettled([this.mcpTransport?.close(), this.mcpServer?.close()]);
    await this.registry.unregisterRun(this.endpointPath, this);
  }

  isBridgeMcpToolCall(toolCall: unknown): boolean {
    if (!isRecord(toolCall)) return false;
    const toolName = getStringField(toolCall, ['name', 'toolName', 'mcpToolName']);
    if (toolName && this.knownMcpToolNames.has(toolName)) return true;

    const isMcpEnvelope = toolName === 'mcp' || toolName === MANIFEST_MCP_SERVER_NAME;
    const cursorMcpCallId = getStringField(toolCall, [
      'call_id',
      'callId',
      'id',
      'toolCallId',
      'requestId',
    ]);
    if (cursorMcpCallId && this.knownCursorMcpCallIds.has(cursorMcpCallId) && isMcpEnvelope) {
      return true;
    }

    return containsKnownMcpToolName(toolCall, this.knownMcpToolNames);
  }

  private async createMcpServer(): Promise<void> {
    const server = new McpProtocolServer(
      { name: 'manifest-tool-bridge', version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.snapshot.tools.map(snapshotToolToMcpTool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      return this.enqueueToolRequest(
        request.params.name,
        request.params.arguments,
        String(extra.requestId),
        extra.signal,
      );
    });

    this.mcpServer = server;
    this.mcpTransport = transport;
    await server.connect(transport);
  }

  private enqueueToolRequest(
    mcpToolName: string,
    argsValue: unknown,
    cursorMcpCallId: string,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const agentToolName = this.snapshot.mcpToolNameToAgentToolName.get(mcpToolName);
    if (!agentToolName) {
      return Promise.resolve({
        content: [{ type: 'text', text: `Unknown manifest bridge tool: ${mcpToolName}` }],
        isError: true,
      });
    }
    if (this.disposed) return Promise.reject(new Error('Manifest tool bridge run is disposed'));

    this.toolCallCounter += 1;
    const bridgeCallId = `${this.id}-bridge-${this.toolCallCounter}`;
    const request: ManifestBridgeToolRequest = {
      runId: this.id,
      bridgeCallId,
      cursorMcpCallId,
      manifestToolCallId: `${this.id}-tool-${this.toolCallCounter}`,
      agentToolName,
      mcpToolName,
      args: normalizeMcpArgs(argsValue),
    };

    return new Promise<CallToolResult>((resolve, reject) => {
      const pending: PendingBridgeCall = {
        request,
        resolve,
        reject,
        signal,
        settled: false,
      };
      pending.onAbort = () => {
        this.rejectPending(
          pending,
          new Error('Manifest MCP bridge tool request was aborted'),
          'cancelled',
        );
      };
      if (signal?.aborted) {
        pending.onAbort();
        return;
      }
      signal?.addEventListener('abort', pending.onAbort, { once: true });
      this.pendingByManifestToolCallId.set(request.manifestToolCallId, pending);
      this.pendingByBridgeCallId.set(request.bridgeCallId, pending);
      this.pendingByCursorMcpCallId.set(cursorMcpCallId, pending);
      this.knownCursorMcpCallIds.add(cursorMcpCallId);
      if (!this.onToolRequest) {
        if (this.liveRunHandlerDetached) {
          this.rejectPending(
            pending,
            new Error('Manifest tool bridge has no active live run'),
            'cancelled',
          );
          return;
        }
        this.queuedRequests.push(request);
        return;
      }
      this.dispatchPendingToolRequest(pending, this.onToolRequest);
    });
  }

  private dispatchPendingToolRequest(
    pending: PendingBridgeCall,
    handler: (request: ManifestBridgeToolRequest) => void,
  ): void {
    try {
      handler(pending.request);
    } catch (error) {
      this.rejectPending(
        pending,
        error instanceof Error ? error : new Error(String(error)),
        'error',
      );
    }
  }

  private rejectQueuedToolRequestsWithoutHandler(reason: string): void {
    while (this.queuedRequests.length > 0) {
      const request = this.queuedRequests.shift()!;
      const pending = this.pendingByManifestToolCallId.get(request.manifestToolCallId);
      if (pending) this.rejectPending(pending, new Error(reason), 'cancelled');
    }
  }

  private resolvePending(pending: PendingBridgeCall, result: CallToolResult): void {
    if (pending.settled) return;
    pending.settled = true;
    this.removePending(pending);
    pending.resolve(result);
  }

  private rejectPending(
    pending: PendingBridgeCall,
    error: Error,
    _kind: 'cancelled' | 'error' = 'error',
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    this.removePending(pending);
    pending.reject(error);
  }

  private removePending(pending: PendingBridgeCall): void {
    pending.signal?.removeEventListener('abort', pending.onAbort ?? (() => undefined));
    this.pendingByManifestToolCallId.delete(pending.request.manifestToolCallId);
    this.pendingByBridgeCallId.delete(pending.request.bridgeCallId);
    if (pending.request.cursorMcpCallId) {
      this.pendingByCursorMcpCallId.delete(pending.request.cursorMcpCallId);
    }
    const queuedIndex = this.queuedRequests.findIndex(
      (r) => r.bridgeCallId === pending.request.bridgeCallId,
    );
    if (queuedIndex >= 0) this.queuedRequests.splice(queuedIndex, 1);
  }
}
