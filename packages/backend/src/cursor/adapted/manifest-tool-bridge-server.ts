/**
 * Adapted from pi-cursor-sdk cursor-pi-tool-bridge-server.ts (MIT). See ATTRIBUTION.md.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ManifestToolBridge,
  ManifestToolBridgeRunOptions,
} from './manifest-tool-bridge-types';
import { isRecord } from './manifest-tool-bridge-mcp';
import { ManifestToolBridgeRunImpl } from './manifest-tool-bridge-run';

export const MANIFEST_BRIDGE_LOOPBACK_HOST = '127.0.0.1';
const HTTP_SERVER_CLOSE_GRACE_MS = 250;

export class ManifestToolBridgeRegistry implements ManifestToolBridge {
  private readonly runs = new Set<ManifestToolBridgeRunImpl>();
  private readonly routes = new Map<string, ManifestToolBridgeRunImpl>();
  private httpServer?: ReturnType<typeof createServer>;
  private listenPromise?: Promise<void>;

  async createRun(options: ManifestToolBridgeRunOptions): Promise<ManifestToolBridgeRunImpl> {
    const enabled = options.snapshot.tools.length > 0;
    const run = new ManifestToolBridgeRunImpl(this, options.snapshot, enabled, options);
    this.runs.add(run);
    await run.start();
    return run;
  }

  async disposeAll(reason = 'Manifest tool bridge disposed'): Promise<void> {
    await Promise.all(
      [...this.runs].map(async (run) => {
        run.cancel(reason);
        await run.dispose();
      }),
    );
  }

  /** Test helper: dispose runs and close the loopback HTTP server even if routes remain. */
  async disposeForTests(): Promise<void> {
    await this.disposeAll('Manifest tool bridge test reset');
    this.routes.clear();
    await this.closeHttpServer();
  }

  async registerRun(pathname: string, run: ManifestToolBridgeRunImpl): Promise<string> {
    await this.ensureHttpServer();
    this.routes.set(pathname, run);
    const address = this.getHttpServerAddress();
    if (!address) throw new Error('Manifest tool bridge HTTP server is not listening');
    return `http://${MANIFEST_BRIDGE_LOOPBACK_HOST}:${address.port}${pathname}`;
  }

  async unregisterRun(pathname: string, run: ManifestToolBridgeRunImpl): Promise<void> {
    if (this.routes.get(pathname) === run) this.routes.delete(pathname);
    this.runs.delete(run);
    if (this.routes.size === 0) await this.closeHttpServer();
  }

  getHttpServerAddress(): AddressInfo | undefined {
    const address = this.httpServer?.address();
    return isRecord(address) && typeof address.port === 'number'
      ? (address as AddressInfo)
      : undefined;
  }

  getEndpointCount(): number {
    return this.routes.size;
  }

  /** Live/integration tests: first active run's manifest_tools MCP URL. */
  getFirstRunMcpUrlForTests(): string | undefined {
    for (const run of this.runs) {
      const manifestTools = run.mcpServers?.manifest_tools as { url?: string } | undefined;
      if (typeof manifestTools?.url === 'string') return manifestTools.url;
    }
    return undefined;
  }

  getFirstBridgeRunForTests(): ManifestToolBridgeRunImpl | undefined {
    return this.runs.values().next().value;
  }

  hasPendingManifestToolCallId(manifestToolCallId: string): boolean {
    for (const run of this.runs) {
      if (run.hasPendingManifestToolCallId(manifestToolCallId)) return true;
    }
    return false;
  }

  private async ensureHttpServer(): Promise<void> {
    if (this.httpServer) {
      await this.listenPromise;
      return;
    }

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    this.httpServer = server;
    this.listenPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, MANIFEST_BRIDGE_LOOPBACK_HOST);
    });
    await this.listenPromise;
  }

  private async closeHttpServer(): Promise<void> {
    const server = this.httpServer;
    if (!server) return;
    this.httpServer = undefined;
    this.listenPromise = undefined;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (closeTimer) clearTimeout(closeTimer);
        if (error) reject(error);
        else resolve();
      };

      closeTimer = setTimeout(() => settle(), HTTP_SERVER_CLOSE_GRACE_MS);
      closeTimer.unref?.();

      server.close((error) => {
        settle(error ?? undefined);
      });
      server.closeIdleConnections();
      server.closeAllConnections();
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.socket.localAddress !== MANIFEST_BRIDGE_LOOPBACK_HOST) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Manifest tool bridge only accepts loopback requests' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://${MANIFEST_BRIDGE_LOOPBACK_HOST}`);
    const run = this.routes.get(url.pathname);
    if (!run) {
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Manifest tool bridge endpoint not found' }));
      return;
    }

    try {
      await run.handleHttpRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }
}

let registeredBridge: ManifestToolBridgeRegistry | undefined;
const testRegistries = new Set<ManifestToolBridgeRegistry>();

export function getManifestToolBridgeRegistry(): ManifestToolBridgeRegistry {
  if (!registeredBridge) registeredBridge = new ManifestToolBridgeRegistry();
  return registeredBridge;
}

export function createManifestToolBridgeRegistryForTests(): ManifestToolBridgeRegistry {
  const registry = new ManifestToolBridgeRegistry();
  testRegistries.add(registry);
  return registry;
}

export async function disposeAllTestManifestToolBridgeRegistriesForTests(): Promise<void> {
  const registries = [...testRegistries];
  testRegistries.clear();
  await Promise.all(registries.map((registry) => registry.disposeForTests()));
}

export async function disposeManifestToolBridgeForTests(): Promise<void> {
  const bridge = registeredBridge;
  registeredBridge = undefined;
  await bridge?.disposeForTests();
}

export async function handleManifestBridgeHttpRequestForTests(
  registry: ManifestToolBridgeRegistry,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return (
    registry as unknown as {
      handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).handleHttpRequest(req, res);
}

export const __manifestBridgeTestUtils = {
  MANIFEST_BRIDGE_LOOPBACK_HOST,
  getRegisteredBridgeForTests: () => registeredBridge,
  getFirstRunMcpUrlForTests: () => registeredBridge?.getFirstRunMcpUrlForTests(),
  getFirstBridgeRunForTests: () => registeredBridge?.getFirstBridgeRunForTests(),
  createRegistry: () => createManifestToolBridgeRegistryForTests(),
  handleManifestBridgeHttpRequestForTests,
};
