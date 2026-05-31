import { registerCursorModelCatalog } from './cursor-model-metadata';
import {
  buildCursorParamCatalog,
  buildCursorParamSpecs,
  isCursorProviderModel,
  listCursorParamModelIds,
} from './cursor-param-spec';

describe('cursor-param-spec', () => {
  beforeEach(() => {
    registerCursorModelCatalog([
      {
        id: 'composer-2.5',
        displayName: 'Composer 2.5',
        parameters: [
          { id: 'fast', displayName: 'Fast', values: [{ value: 'false' }, { value: 'true' }] },
        ],
        variants: [
          { params: [{ id: 'fast', value: 'true' }], displayName: 'Composer 2.5', isDefault: true },
        ],
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT 5.5',
        parameters: [
          { id: 'context', displayName: 'Context', values: [{ value: '272k' }, { value: '1m' }] },
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            values: [{ value: 'none' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
          },
        ],
        variants: [
          {
            params: [
              { id: 'context', value: '1m' },
              { id: 'reasoning', value: 'medium' },
            ],
            displayName: 'GPT 5.5',
            isDefault: true,
          },
        ],
      },
    ]);
  });

  it('builds mode + fast specs for fast-capable models', () => {
    const specs = buildCursorParamSpecs('cursor/composer-2.5');
    expect(specs.map((spec) => spec.path)).toEqual(['cursor.mode', 'cursor.fast']);
  });

  it('builds reasoning level specs from thinkingLevelMap', () => {
    const specs = buildCursorParamSpecs('cursor/gpt-5.5@1m');
    expect(specs.map((spec) => spec.path)).toEqual(['cursor.mode', 'cursor.reasoning_level']);
    const reasoning = specs.find((spec) => spec.path === 'cursor.reasoning_level');
    expect(reasoning?.values).toEqual(expect.arrayContaining(['off', 'low', 'medium', 'high']));
  });

  it('lists cursor models in the param catalog', () => {
    const catalog = buildCursorParamCatalog();
    expect(catalog.some((entry) => entry.model === 'cursor/composer-2.5')).toBe(true);
    expect(catalog.every((entry) => entry.provider === 'cursor')).toBe(true);
  });

  it('listCursorParamModelIds returns cursor subscription models', () => {
    expect(listCursorParamModelIds()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'cursor',
          authType: 'subscription',
          model: 'cursor/composer-2.5',
        }),
      ]),
    );
  });

  it('isCursorProviderModel matches cursor subscription routes', () => {
    expect(isCursorProviderModel('cursor', 'subscription', 'cursor/composer-2.5')).toBe(true);
    expect(isCursorProviderModel('openai', 'subscription', 'cursor/composer-2.5')).toBe(false);
  });

  it('returns no specs when metadata is missing', () => {
    expect(buildCursorParamSpecs('cursor/unknown-model')).toEqual([]);
  });
});
