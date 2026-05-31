import { buildCursorToolManifestText } from './cursor-tool-manifest';
import { buildManifestToolBridgeSnapshotFromOpenAiTools } from './adapted/manifest-tool-bridge-snapshot';

describe('cursor-tool-manifest', () => {
  it('lists only manifest bridge tools when snapshot has tools', () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const text = buildCursorToolManifestText({ bridgeSnapshot: snapshot, bridgeEnabled: true });
    expect(text).toContain('manifest__bash');
    expect(text).toContain('Bridged tool schemas:');
    expect(text).not.toContain('Cursor SDK host tools');
  });

  it('includes generic schema hints for any bridged tool', () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      {
        type: 'function',
        function: {
          name: 'web_search',
          parameters: {
            type: 'object',
            required: ['query'],
            properties: { query: { type: 'string', description: 'Search query' } },
          },
        },
      },
    ]);
    expect(
      buildCursorToolManifestText({ bridgeSnapshot: snapshot, bridgeEnabled: true }),
    ).toContain('Required: query');
  });

  it('notes when bridge is disabled or empty', () => {
    expect(buildCursorToolManifestText({ bridgeEnabled: false })).toBe(
      ['Callable tool surfaces this run:', '- Manifest bridge: disabled.'].join('\n'),
    );
    expect(buildCursorToolManifestText({ bridgeEnabled: true })).toBe(
      [
        'Callable tool surfaces this run:',
        '- Manifest bridge: no manifest__* tools exposed this run.',
        '- Reply with text only.',
      ].join('\n'),
    );
  });
});
