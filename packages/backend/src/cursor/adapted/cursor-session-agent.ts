/**
 * Adapted from pi-cursor-sdk (MIT). See ATTRIBUTION.md.
 * Phase 3: manifest__ tool bridge via loopback MCP.
 */
import { createHash } from 'node:crypto';
import type { AgentModeOption, ModelSelection, SDKAgent } from '@cursor/sdk';
import { Agent } from '@cursor/sdk';
import { getManifestCursorSettingSources } from '../cursor-setting-sources';
import type {
  ManifestBridgeToolRequest,
  ManifestToolBridgeRun,
} from './manifest-tool-bridge-types';
import { buildManifestToolBridgeSurfaceSignature } from './manifest-tool-bridge-snapshot';
import type { SessionCursorAgentSendState } from './cursor-session-send-policy';

export interface SessionCursorAgentLease {
  scopeKey: string;
  poolKey: string;
  instanceId: number;
  agent: SDKAgent;
  bridgeRun?: ManifestToolBridgeRun;
  sendState: SessionCursorAgentSendState;
  created: boolean;
  commitSend(contextFingerprint: string, bootstrapped: boolean): void;
  trackRunCompletion(completion: Promise<unknown>): void;
}

interface SessionCursorAgentCreateParams {
  apiKey: string;
  agentMode: AgentModeOption;
  cwd: string;
  modelSelection: ModelSelection;
  bridgeSurfaceSignature?: string;
  bridgeRun?: ManifestToolBridgeRun;
  onBridgeToolRequest?: (request: ManifestBridgeToolRequest) => void;
  createAgent?: typeof Agent.create;
}

interface SessionCursorAgentEntryBase {
  poolKey: string;
  instanceId: number;
  scopeKey: string;
  sendState: SessionCursorAgentSendState;
}

interface ReadyEntry extends SessionCursorAgentEntryBase {
  status: 'ready';
  agent: SDKAgent;
  bridgeRun?: ManifestToolBridgeRun;
}

interface BusyEntry extends SessionCursorAgentEntryBase {
  status: 'busy';
  agent: SDKAgent;
  bridgeRun?: ManifestToolBridgeRun;
  pendingCompletion: Promise<void>;
  releaseBusyWait: () => void;
}

interface CreatingEntry {
  status: 'creating';
  poolKey: string;
  instanceId: number;
  scopeKey: string;
  sendState: SessionCursorAgentSendState;
  creating: Promise<ReadyEntry>;
}

type PoolEntry = CreatingEntry | ReadyEntry | BusyEntry;

const sessionAgentsByScope = new Map<string, PoolEntry>();
let nextInstanceId = 1;

function buildModelPoolKey(modelSelection: ModelSelection): string {
  return JSON.stringify(modelSelection);
}

function buildApiKeyPoolKeyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function buildSessionAgentPoolKey(
  scopeKey: string,
  params: SessionCursorAgentCreateParams,
): string {
  const settingSources = getManifestCursorSettingSources();
  return [
    scopeKey,
    params.cwd,
    buildModelPoolKey(params.modelSelection),
    settingSources.join(','),
    buildApiKeyPoolKeyFingerprint(params.apiKey),
    params.bridgeSurfaceSignature ?? 'bridge:none',
  ].join('\0');
}

function createInitialSendState(): SessionCursorAgentSendState {
  return { bootstrapped: false, contextFingerprint: '', incrementalSendCount: 0 };
}

async function disposeBridgeRun(
  bridgeRun: ManifestToolBridgeRun | undefined,
  reason: string,
): Promise<void> {
  if (!bridgeRun) return;
  bridgeRun.cancel(reason);
  try {
    await bridgeRun.dispose();
  } catch {
    // disposal failure should not block replacement
  }
}

async function disposeEntry(entry: ReadyEntry | BusyEntry): Promise<void> {
  await disposeBridgeRun(entry.bridgeRun, 'Cursor session agent disposed');
  try {
    await entry.agent[Symbol.asyncDispose]();
  } catch {
    // disposal failure should not block replacement
  }
}

async function disposeScope(scopeKey: string): Promise<void> {
  const entry = sessionAgentsByScope.get(scopeKey);
  if (!entry) return;
  sessionAgentsByScope.delete(scopeKey);
  if (entry.status === 'creating') return;
  if (entry.status === 'busy') entry.releaseBusyWait();
  await disposeEntry(entry);
}

function leaseFromReady(
  entry: ReadyEntry,
  scopeKey: string,
  created: boolean,
): SessionCursorAgentLease {
  return {
    scopeKey,
    poolKey: entry.poolKey,
    instanceId: entry.instanceId,
    agent: entry.agent,
    bridgeRun: entry.bridgeRun,
    sendState: entry.sendState,
    created,
    commitSend: (contextFingerprint, bootstrapped) => {
      const current = sessionAgentsByScope.get(scopeKey);
      if (
        !current ||
        current.poolKey !== entry.poolKey ||
        current.instanceId !== entry.instanceId
      ) {
        return;
      }
      if (current.status === 'creating') return;
      current.sendState.bootstrapped = bootstrapped || current.sendState.bootstrapped;
      current.sendState.contextFingerprint = contextFingerprint;
      if (bootstrapped) {
        current.sendState.incrementalSendCount = 0;
      } else {
        current.sendState.incrementalSendCount += 1;
      }
    },
    trackRunCompletion: (completion) => {
      const current = sessionAgentsByScope.get(scopeKey);
      if (!current || current.status === 'creating') return;
      if (current.poolKey !== entry.poolKey || current.instanceId !== entry.instanceId) return;

      let releaseBusyWait = (): void => {};
      const releaseSignal = new Promise<'released'>((resolve) => {
        releaseBusyWait = () => resolve('released');
      });
      const pendingCompletion = Promise.race([
        completion.then(
          () => 'completed' as const,
          () => 'completed' as const,
        ),
        releaseSignal,
      ]).then((outcome) => {
        const latest = sessionAgentsByScope.get(scopeKey);
        if (
          outcome === 'completed' &&
          latest?.status === 'busy' &&
          latest.poolKey === entry.poolKey &&
          latest.instanceId === entry.instanceId
        ) {
          sessionAgentsByScope.set(scopeKey, { ...latest, status: 'ready' });
        }
      });

      sessionAgentsByScope.set(scopeKey, {
        ...current,
        status: 'busy',
        pendingCompletion,
        releaseBusyWait,
      } as BusyEntry);
    },
  };
}

async function createReadyEntry(
  scopeKey: string,
  instanceId: number,
  sendState: SessionCursorAgentSendState,
  params: SessionCursorAgentCreateParams,
): Promise<ReadyEntry> {
  const poolKey = buildSessionAgentPoolKey(scopeKey, params);
  const createAgent = params.createAgent ?? Agent.create;
  const settingSources = getManifestCursorSettingSources();
  const bridgeRun = params.bridgeRun;
  if (bridgeRun) {
    bridgeRun.setOnToolRequest(params.onBridgeToolRequest);
  }

  const agent = await createAgent({
    apiKey: params.apiKey,
    model: params.modelSelection,
    mode: params.agentMode,
    local: { cwd: params.cwd, settingSources },
    platform: { workspaceRef: params.cwd },
    ...(bridgeRun?.mcpServers ? { mcpServers: bridgeRun.mcpServers } : {}),
  });

  return {
    status: 'ready',
    poolKey,
    instanceId,
    scopeKey,
    agent,
    bridgeRun,
    sendState,
  };
}

export async function acquireSessionCursorAgent(
  scopeKey: string,
  params: SessionCursorAgentCreateParams,
): Promise<SessionCursorAgentLease> {
  while (true) {
    const poolKey = buildSessionAgentPoolKey(scopeKey, params);
    const state = sessionAgentsByScope.get(scopeKey);

    if (
      state &&
      (state.status === 'ready' || state.status === 'busy') &&
      state.poolKey !== poolKey
    ) {
      await disposeScope(scopeKey);
      continue;
    }

    if (state?.status === 'ready' && state.poolKey === poolKey) {
      if (params.bridgeRun && params.bridgeRun !== state.bridgeRun) {
        if (!state.bridgeRun) {
          await disposeScope(scopeKey);
          continue;
        }
        await disposeBridgeRun(params.bridgeRun, 'Unused Cursor session bridge replaced');
      }
      state.bridgeRun?.setOnToolRequest(params.onBridgeToolRequest);
      return leaseFromReady(state, scopeKey, false);
    }

    if (state?.status === 'busy' && state.poolKey === poolKey) {
      await state.pendingCompletion;
      continue;
    }

    if (state?.status === 'creating' && state.poolKey === poolKey) {
      await state.creating;
      continue;
    }

    const instanceId = nextInstanceId++;
    const sendState = createInitialSendState();
    let placeholder: CreatingEntry;
    const creating = createReadyEntry(scopeKey, instanceId, sendState, params).then((ready) => {
      if (sessionAgentsByScope.get(scopeKey) === placeholder) {
        sessionAgentsByScope.set(scopeKey, ready);
      } else {
        void disposeEntry(ready);
      }
      return ready;
    });
    placeholder = {
      status: 'creating',
      poolKey,
      instanceId,
      scopeKey,
      sendState,
      creating,
    };
    sessionAgentsByScope.set(scopeKey, placeholder);

    try {
      const ready = await creating;
      if (ready.poolKey === poolKey) {
        return leaseFromReady(ready, scopeKey, true);
      }
    } catch {
      if (sessionAgentsByScope.get(scopeKey) === placeholder) {
        sessionAgentsByScope.delete(scopeKey);
      }
      throw new Error('Cursor session agent creation failed');
    }
  }
}

export async function resetSessionCursorAgent(scopeKey: string): Promise<void> {
  await disposeScope(scopeKey);
}

export async function disposeAllSessionCursorAgents(): Promise<void> {
  const keys = [...sessionAgentsByScope.keys()];
  await Promise.all(keys.map((key) => disposeScope(key)));
}

export const __testUtils = {
  sessionAgentsByScope,
  disposeAllSessionCursorAgents,
  buildSessionAgentPoolKey,
  buildApiKeyPoolKeyFingerprint,
  buildManifestToolBridgeSurfaceSignature,
};
