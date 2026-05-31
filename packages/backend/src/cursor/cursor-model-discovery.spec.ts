import { Cursor } from '@cursor/sdk';
import {
  buildCursorFallbackModels,
  discoverCursorModels,
  __testUtils,
} from './cursor-model-discovery';

jest.mock('@cursor/sdk', () => ({
  Cursor: {
    models: {
      list: jest.fn(),
    },
  },
}));

const mockList = Cursor.models.list as jest.Mock;

describe('buildCursorFallbackModels', () => {
  it('returns expanded cursor models with zero pricing', () => {
    const models = buildCursorFallbackModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'cursor')).toBe(true);
    expect(models.every((m) => m.id.startsWith('cursor/'))).toBe(true);
    expect(models.every((m) => m.inputPricePerToken === 0 && m.outputPricePerToken === 0)).toBe(
      true,
    );
    expect(models.some((m) => m.id === 'cursor/composer-2.5')).toBe(true);
  });
});

describe('discoverCursorModels', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('returns [] for empty api key', async () => {
    expect(await discoverCursorModels('')).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('expands models from Cursor.models.list', async () => {
    mockList.mockResolvedValue([
      {
        id: 'composer-2.5',
        displayName: 'Composer 2.5',
        variants: [{ params: [], displayName: 'Composer 2.5', isDefault: true }],
      },
    ]);
    const models = await discoverCursorModels('cursor-key-123');
    expect(mockList).toHaveBeenCalledWith({ apiKey: 'cursor-key-123' });
    expect(models).toEqual([
      expect.objectContaining({
        id: 'cursor/composer-2.5',
        displayName: 'Composer 2.5',
        provider: 'cursor',
        inputPricePerToken: 0,
        outputPricePerToken: 0,
      }),
    ]);
  });

  it('returns [] when discovery throws', async () => {
    mockList.mockRejectedValue(new Error('auth failed'));
    expect(await discoverCursorModels('bad-key')).toEqual([]);
  });

  it('returns [] when discovery returns empty list', async () => {
    mockList.mockResolvedValue([]);
    expect(await discoverCursorModels('key')).toEqual([]);
  });
});

describe('__testUtils.expandModelListItems', () => {
  it('encodes context window in model id suffix', () => {
    const models = __testUtils.expandModelListItems([
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        parameters: [
          {
            id: 'context',
            displayName: 'Context',
            values: [
              { value: '200k', displayName: '200K' },
              { value: '1m', displayName: '1M' },
            ],
          },
        ],
        variants: [
          { params: [{ id: 'context', value: '1m' }], displayName: 'Sonnet 4.6', isDefault: true },
        ],
      },
    ]);
    expect(models.map((m) => m.id).sort()).toEqual([
      'cursor/claude-sonnet-4-6@1m',
      'cursor/claude-sonnet-4-6@200k',
    ]);
    expect(models.find((m) => m.id.endsWith('@1m'))?.contextWindow).toBe(1_000_000);
  });

  it('parseContextWindow handles k and m suffixes', () => {
    expect(__testUtils.parseContextWindow('200k')).toBe(200_000);
    expect(__testUtils.parseContextWindow('1.5m')).toBe(1_500_000);
    expect(__testUtils.parseContextWindow('1m')).toBe(1_000_000);
    expect(__testUtils.parseContextWindow('bogus')).toBeUndefined();
  });

  it('skips duplicate manifest ids when variants collide', () => {
    const models = __testUtils.expandModelListItems([
      {
        id: 'dup-model',
        displayName: 'Dup',
        variants: [
          { params: [], displayName: 'Dup', isDefault: true },
          { params: [], displayName: 'Dup alt', isDefault: false },
        ],
      },
    ]);
    expect(models.filter((m) => m.id === 'cursor/dup-model')).toHaveLength(1);
  });

  it('includes reasoning capability when model exposes effort param', () => {
    const models = __testUtils.expandModelListItems([
      {
        id: 'thinker',
        displayName: 'Thinker',
        parameters: [{ id: 'effort', displayName: 'Effort', values: [] }],
        variants: [{ params: [], displayName: 'Thinker', isDefault: true }],
      },
    ]);
    expect(models[0].capabilityReasoning).toBe(true);
  });

  it('ignores ambiguous aliases shared across models', () => {
    const models = __testUtils.expandModelListItems([
      { id: 'model-a', displayName: 'A', aliases: ['shared'] },
      { id: 'model-b', displayName: 'B', aliases: ['shared'] },
    ]);
    expect(models.every((m) => !m.id.includes('shared'))).toBe(true);
  });
});
