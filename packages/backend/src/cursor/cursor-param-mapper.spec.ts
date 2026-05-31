import { parseCursorManifestModel } from './cursor-param-mapper';

describe('cursor-param-mapper', () => {
  it('parses model id without cursor/ prefix', () => {
    expect(parseCursorManifestModel('composer-2.5')).toEqual({
      manifestModelId: 'cursor/composer-2.5',
      selection: { id: 'composer-2.5' },
    });
  });

  it('parses bare cursor model id', () => {
    expect(parseCursorManifestModel('cursor/composer-2.5')).toEqual({
      manifestModelId: 'cursor/composer-2.5',
      selection: { id: 'composer-2.5' },
    });
  });

  it('parses context suffix into model params', () => {
    expect(parseCursorManifestModel('cursor/composer-2.5@128k')).toEqual({
      manifestModelId: 'cursor/composer-2.5@128k',
      selection: {
        id: 'composer-2.5',
        params: [{ id: 'context', value: '128k' }],
      },
    });
  });
});
