const listenError = new Error('listen EADDRINUSE');

jest.mock('node:http', () => {
  const actual = jest.requireActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const originalOnce = server.once.bind(server);
      server.once = ((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'error') queueMicrotask(() => listener(listenError));
        return originalOnce(event, listener);
      }) as typeof server.once;
      return server;
    },
  };
});

import {
  disposeManifestToolBridgeForTests,
  __manifestBridgeTestUtils,
} from './manifest-tool-bridge-server';
import { buildManifestToolBridgeSnapshotFromOpenAiTools } from './manifest-tool-bridge-snapshot';

describe('manifest-tool-bridge-server listen failures', () => {
  afterEach(async () => {
    await disposeManifestToolBridgeForTests();
  });

  it('rejects when the HTTP server fails to listen', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    await expect(registry.createRun({ snapshot })).rejects.toThrow('listen EADDRINUSE');
  });
});
