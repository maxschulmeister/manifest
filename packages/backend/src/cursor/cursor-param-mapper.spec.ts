import { registerCursorModelCatalog } from './cursor-model-metadata';
import type { CursorModelMetadata } from './cursor-model-metadata';
import {
  buildCursorModelSelection,
  extractCursorRouteParams,
  parseCursorManifestModel,
  resolveCursorAgentMode,
  stripCursorRouteParams,
  __testUtils,
} from './cursor-param-mapper';

describe('cursor-param-mapper', () => {
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
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        parameters: [
          { id: 'context', displayName: 'Context', values: [{ value: '1m' }, { value: '300k' }] },
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
              { id: 'context', value: '1m' },
              { id: 'thinking', value: 'true' },
              { id: 'effort', value: 'medium' },
            ],
            displayName: 'Opus 4.8',
            isDefault: true,
          },
        ],
      },
    ]);
  });

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

  it('extracts cursor route params from flat MPS storage', () => {
    expect(
      extractCursorRouteParams({
        'cursor.reasoning_level': 'high',
        'cursor.fast': true,
        'cursor.mode': 'plan',
      }),
    ).toEqual({
      reasoningLevel: 'high',
      fast: true,
      mode: 'plan',
    });
  });

  it('defaults agent mode when route params omit mode', () => {
    expect(resolveCursorAgentMode({})).toBe('agent');
    expect(resolveCursorAgentMode({ mode: 'plan' })).toBe('plan');
  });

  it('buildCursorModelSelection maps reasoning level to effort params', () => {
    expect(
      buildCursorModelSelection('cursor/claude-opus-4-8@1m', { reasoningLevel: 'xhigh' }),
    ).toEqual({
      id: 'claude-opus-4-8',
      params: expect.arrayContaining([
        { id: 'context', value: '1m' },
        { id: 'thinking', value: 'true' },
        { id: 'effort', value: 'xhigh' },
      ]),
    });
  });

  it('buildCursorModelSelection maps off to thinking=false for Claude-style models', () => {
    expect(
      buildCursorModelSelection('cursor/claude-opus-4-8@1m', { reasoningLevel: 'off' }),
    ).toEqual({
      id: 'claude-opus-4-8',
      params: expect.arrayContaining([{ id: 'thinking', value: 'false' }]),
    });
  });

  it('buildCursorModelSelection applies fast override when supported', () => {
    expect(buildCursorModelSelection('cursor/composer-2.5', { fast: false })).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'false' }],
    });
  });

  it('stripCursorRouteParams removes cursor.* keys from request body', () => {
    expect(
      stripCursorRouteParams({
        model: 'cursor/composer-2.5',
        messages: [],
        'cursor.fast': true,
        'cursor.mode': 'plan',
      }),
    ).toEqual({
      model: 'cursor/composer-2.5',
      messages: [],
    });
  });

  it('buildCursorModelSelection falls back when metadata is missing', () => {
    expect(buildCursorModelSelection('cursor/unknown-model@128k')).toEqual({
      id: 'unknown-model',
      params: [{ id: 'context', value: '128k' }],
    });
  });

  it('maps reasoning=none for GPT-style models when level is off', () => {
    registerCursorModelCatalog([
      {
        id: 'gpt-5.5',
        displayName: 'GPT 5.5',
        parameters: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            values: [{ value: 'none' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
          },
        ],
        variants: [
          {
            params: [{ id: 'reasoning', value: 'medium' }],
            displayName: 'GPT 5.5',
            isDefault: true,
          },
        ],
      },
    ]);

    expect(buildCursorModelSelection('cursor/gpt-5.5', { reasoningLevel: 'off' })).toEqual({
      id: 'gpt-5.5',
      params: [{ id: 'reasoning', value: 'none' }],
    });
    expect(buildCursorModelSelection('cursor/gpt-5.5', { reasoningLevel: 'high' })).toEqual({
      id: 'gpt-5.5',
      params: [{ id: 'reasoning', value: 'high' }],
    });
  });

  it('maps boolean thinking models through the thinking param only', () => {
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

    expect(buildCursorModelSelection('cursor/haiku', { reasoningLevel: 'high' })).toEqual({
      id: 'haiku',
      params: [{ id: 'thinking', value: 'true' }],
    });
  });

  it('extractCursorRouteParams ignores invalid values', () => {
    expect(extractCursorRouteParams(null)).toEqual({});
    expect(
      extractCursorRouteParams({
        'cursor.reasoning_level': 'turbo',
        'cursor.fast': 'yes',
        'cursor.mode': 'debug',
      }),
    ).toEqual({});
  });

  it('applyReasoningLevel pushes params when the target id is missing', () => {
    const metadata = {
      parameterIds: {
        context: false,
        reasoning: true,
        effort: false,
        thinking: false,
        fast: false,
      },
      thinkingLevelMap: { high: 'high' },
    } as CursorModelMetadata;
    const params: { id: string; value: string }[] = [];

    __testUtils.applyReasoningLevel(metadata, params, 'high');

    expect(params).toEqual([{ id: 'reasoning', value: 'high' }]);
  });
});
