import { BadRequestException } from '@nestjs/common';
import { assertAliasRouteConfigured, parseModelAliasFromBody } from '../model-alias-validation';

const routingAliasService = {
  classifyModel: jest.fn(),
  listAcceptedModelIds: jest.fn(),
};

describe('parseModelAliasFromBody', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    routingAliasService.listAcceptedModelIds.mockResolvedValue(['auto', 'simple', 'ht-fast']);
  });

  it('returns the classified model value', async () => {
    routingAliasService.classifyModel.mockResolvedValue({ kind: 'tier', tier: 'simple' });

    await expect(
      parseModelAliasFromBody({ model: 'simple', messages: [] }, 'agent-1', {
        routingAliasService,
      }),
    ).resolves.toEqual({ kind: 'tier', tier: 'simple' });
  });

  it('passes through custom tiers from the classifier', async () => {
    routingAliasService.classifyModel.mockResolvedValue({ kind: 'header_tier', id: 'ht-fast' });

    await expect(
      parseModelAliasFromBody({ model: 'ht-fast', messages: [] }, 'agent-1', {
        routingAliasService,
      }),
    ).resolves.toEqual({ kind: 'header_tier', id: 'ht-fast' });
  });

  it('defaults to auto when model is missing', async () => {
    await expect(
      parseModelAliasFromBody({ messages: [] }, 'agent-1', {
        routingAliasService,
      }),
    ).resolves.toEqual({ kind: 'auto' });
  });

  it('throws M410 when model is empty', async () => {
    await expect(
      parseModelAliasFromBody({ model: '', messages: [] }, 'agent-1', {
        routingAliasService,
      }),
    ).rejects.toThrow(/M410/);
  });

  it('throws M410 for an unrecognized model', async () => {
    routingAliasService.classifyModel.mockResolvedValue(null);

    await expect(
      parseModelAliasFromBody({ model: 'banana' }, 'agent-1', {
        routingAliasService,
      }),
    ).rejects.toThrow(/M410/);
  });
});

describe('assertAliasRouteConfigured', () => {
  it('throws M411 when route is null', () => {
    expect(() =>
      assertAliasRouteConfigured('ht-fast', { route: null } as never, 'https://dash/routing'),
    ).toThrow(BadRequestException);
  });

  it('does not throw when route is set', () => {
    expect(() =>
      assertAliasRouteConfigured(
        'simple',
        { route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' } } as never,
        'https://dash/routing',
      ),
    ).not.toThrow();
  });
});
