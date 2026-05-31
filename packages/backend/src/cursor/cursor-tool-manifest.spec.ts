import { buildCursorToolManifestText } from './cursor-tool-manifest';
import { buildManifestToolBridgeSnapshotFromOpenAiTools } from './adapted/manifest-tool-bridge-snapshot';

describe('cursor-tool-manifest', () => {
  it('lists manifest bridge tools when snapshot has tools', () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const text = buildCursorToolManifestText({ bridgeSnapshot: snapshot, bridgeEnabled: true });
    expect(text).toContain('manifest__bash');
    expect(text).toContain('Callable tool surfaces');
  });

  it('notes when bridge is disabled or empty', () => {
    expect(buildCursorToolManifestText({ bridgeEnabled: false })).toContain('disabled');
    expect(buildCursorToolManifestText({ bridgeEnabled: true })).toContain('no manifest__');
  });
});
