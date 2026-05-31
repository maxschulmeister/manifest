import type { ModelListItem } from '@cursor/sdk';
import {
  getCursorModelMetadata,
  listCursorModelMetadata,
  registerCursorModelCatalog,
  __testUtils,
} from './cursor-model-metadata';

describe('cursor-model-metadata', () => {
  afterEach(() => {
    registerCursorModelCatalog([]);
  });

  it('registers context variants with correct context windows', () => {
    registerCursorModelCatalog([
      {
        id: 'gpt-5.5',
        displayName: 'GPT 5.5',
        parameters: [
          {
            id: 'context',
            displayName: 'Context',
            values: [{ value: '272k' }, { value: '1m' }],
          },
        ],
        variants: [
          { params: [{ id: 'context', value: '1m' }], displayName: 'GPT 5.5', isDefault: true },
        ],
      },
    ]);

    expect(getCursorModelMetadata('cursor/gpt-5.5@272k')?.contextWindow).toBe(272_000);
    expect(getCursorModelMetadata('cursor/gpt-5.5@1m')?.contextWindow).toBe(1_000_000);
  });

  it('skips ambiguous shared aliases', () => {
    registerCursorModelCatalog([
      { id: 'model-a', displayName: 'A', aliases: ['shared'] },
      { id: 'model-b', displayName: 'B', aliases: ['shared'] },
    ]);
    expect(listCursorModelMetadata().some((m) => m.selectionModelId === 'shared')).toBe(false);
  });

  it('builds thinkingLevelMap for effort models', () => {
    registerCursorModelCatalog([
      {
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        parameters: [
          {
            id: 'thinking',
            displayName: 'Thinking',
            values: [{ value: 'false' }, { value: 'true' }],
          },
          {
            id: 'effort',
            displayName: 'Effort',
            values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
          },
        ],
        variants: [
          {
            params: [
              { id: 'thinking', value: 'true' },
              { id: 'effort', value: 'medium' },
            ],
            displayName: 'Opus 4.8',
            isDefault: true,
          },
        ],
      },
    ]);

    const metadata = getCursorModelMetadata('cursor/claude-opus-4-8');
    expect(metadata?.supportsReasoning).toBe(true);
    expect(metadata?.thinkingLevelMap?.off).toBe('false');
    expect(metadata?.thinkingLevelMap?.medium).toBe('medium');
    expect(metadata?.thinkingLevelMap?.xhigh).toBe('xhigh');
  });

  it('parseContextWindow handles k and m suffixes', () => {
    expect(__testUtils.parseContextWindow('272k')).toBe(272_000);
    expect(__testUtils.parseContextWindow('1m')).toBe(1_000_000);
    expect(__testUtils.parseContextWindow('bogus')).toBeUndefined();
    expect(__testUtils.parseContextWindow('not-a-numberk')).toBeUndefined();
  });

  it('registers aliases and normalizes manifest model ids without prefix', () => {
    registerCursorModelCatalog([
      {
        id: 'primary-model',
        displayName: '',
        aliases: ['alias-model', 'primary-model', '  '],
        variants: [{ params: [], displayName: '', isDefault: true }],
      },
    ]);

    expect(getCursorModelMetadata('alias-model')).toBeDefined();
    expect(getCursorModelMetadata('cursor/alias-model')?.displayName).toBe('primary-model');
  });

  it('uses first variant when no default variant is marked', () => {
    registerCursorModelCatalog([
      {
        id: 'no-default',
        displayName: 'No Default',
        variants: [
          { params: [{ id: 'fast', value: 'false' }], displayName: 'Slow', isDefault: false },
          { params: [{ id: 'fast', value: 'true' }], displayName: 'Fast', isDefault: false },
        ],
      },
    ]);

    expect(getCursorModelMetadata('cursor/no-default')?.defaultParams).toEqual([
      { id: 'fast', value: 'false' },
    ]);
  });

  it('registers boolean thinking models with minimal reasoning levels', () => {
    registerCursorModelCatalog([
      {
        id: 'haiku',
        displayName: 'Haiku',
        parameters: [
          {
            id: 'thinking',
            displayName: 'Thinking',
            values: [{ value: 'false' }, { value: 'true' }],
          },
        ],
        variants: [
          { params: [{ id: 'thinking', value: 'false' }], displayName: 'Haiku', isDefault: true },
        ],
      },
    ]);

    const metadata = getCursorModelMetadata('cursor/haiku');
    expect(metadata?.thinkingLevelMap).toEqual({
      off: 'false',
      minimal: null,
      low: null,
      medium: null,
      high: 'true',
      xhigh: null,
    });
  });

  it('skips duplicate manifest ids when alias collides with base id', () => {
    registerCursorModelCatalog([{ id: 'dup', displayName: 'Dup', aliases: ['dup'] }]);

    expect(listCursorModelMetadata().filter((m) => m.selectionModelId === 'dup')).toHaveLength(1);
  });
});
