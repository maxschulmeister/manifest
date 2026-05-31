import { getManifestCursorSettingSources } from './cursor-setting-sources';

describe('cursor-setting-sources', () => {
  it('forces empty setting sources for Manifest', () => {
    expect(getManifestCursorSettingSources()).toEqual([]);
  });
});
