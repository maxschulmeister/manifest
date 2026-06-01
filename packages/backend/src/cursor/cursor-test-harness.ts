import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { disposeAllSessionCursorAgents } from './adapted/cursor-session-agent';
import { restoreCursorMcpToolTimeoutOverrideForTests } from './adapted/cursor-mcp-timeout-override';
import { releaseAllManifestCursorLiveRunsForTests } from './adapted/manifest-cursor-live-run';
import {
  disposeAllTestManifestToolBridgeRegistriesForTests,
  disposeManifestToolBridgeForTests,
} from './adapted/manifest-tool-bridge-server';

const CURSOR_LIVE_TESTS_ENV = 'RUN_CURSOR_LIVE_TESTS';

/** Opt-in flag for live Cursor SDK integration tests (never keyed off CURSOR_API_KEY alone). */
export function isCursorLiveTestsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[CURSOR_LIVE_TESTS_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export async function disposeCursorTestState(): Promise<void> {
  await releaseAllManifestCursorLiveRunsForTests();
  await disposeAllTestManifestToolBridgeRegistriesForTests();
  await disposeManifestToolBridgeForTests();
  await disposeAllSessionCursorAgents();
  restoreCursorMcpToolTimeoutOverrideForTests();
}

export async function withMcpTestClient<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'manifest-cursor-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await Promise.allSettled([
      transport.close().catch(() => undefined),
      client.close().catch(() => undefined),
    ]);
  }
}
