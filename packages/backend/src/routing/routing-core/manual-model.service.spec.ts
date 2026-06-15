import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ManualModelService } from './manual-model.service';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { ProviderService } from './provider.service';
import { RoutingCacheService } from './routing-cache.service';
import { ProviderParamSpecService } from './provider-param-spec.service';
import { UserProvider } from '../../entities/user-provider.entity';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';

function makeProvider(overrides: Partial<UserProvider> = {}): UserProvider {
  return {
    id: 'prov-1',
    user_id: 'user-1',
    agent_id: 'agent-1',
    provider: 'anthropic',
    api_key_encrypted: 'enc',
    key_prefix: 'sk-',
    auth_type: 'api_key',
    label: 'Default',
    priority: 0,
    region: null,
    is_active: true,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cached_models: null,
    manual_models: null,
    models_fetched_at: null,
    ...overrides,
  } as UserProvider;
}

describe('ManualModelService', () => {
  let service: ManualModelService;
  let savedRows: UserProvider[];
  let refreshCalls: { agent: string; provider: string; auth: string }[];
  let recalcCalls: string[];
  let invalidateAgent: jest.Mock;
  let catalogSpecs: unknown[];

  /**
   * The two internal collaborators (ModelDiscoveryService, ProviderService)
   * are injected as thin fakes that stand in for the "make it visible" steps.
   * We never assert that they were called with particular arguments — that
   * would be testing HOW the orchestration happens rather than WHAT it does.
   * The real end-to-end behaviour (add → model discoverable) is covered by
   * test/manual-models.e2e-spec.ts. Here we assert the service's own state:
   * what it persists, returns, and rejects.
   */
  async function buildService(rows: UserProvider[]) {
    savedRows = [];
    refreshCalls = [];
    recalcCalls = [];
    catalogSpecs = [{ path: 'temperature' }];
    const repo = {
      find: jest.fn().mockResolvedValue(rows),
      save: jest.fn().mockImplementation((row: UserProvider) => {
        savedRows.push(row);
        return Promise.resolve(row);
      }),
    };
    const discovery = {
      refreshProvider: (agent: string, provider: string, auth: string) => {
        refreshCalls.push({ agent, provider, auth });
        return Promise.resolve({ ok: true, model_count: 1 });
      },
    };
    const providerService = {
      recalculateTiers: (agent: string) => {
        recalcCalls.push(agent);
        return Promise.resolve();
      },
    };
    invalidateAgent = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ManualModelService,
        { provide: getRepositoryToken(UserProvider), useValue: repo },
        { provide: ModelDiscoveryService, useValue: discovery },
        { provide: ProviderService, useValue: providerService },
        { provide: RoutingCacheService, useValue: { invalidateAgent } },
        { provide: ProviderParamSpecService, useValue: { getCatalogSpecs: () => catalogSpecs } },
      ],
    }).compile();

    return moduleRef.get(ManualModelService);
  }

  /* ── list ── */

  describe('list', () => {
    it('returns the manual models saved on the active connection', async () => {
      service = await buildService([
        makeProvider({ manual_models: [{ model_name: 'claude-secret' }] }),
      ]);

      expect(await service.list('agent-1', 'anthropic', 'api_key')).toEqual([
        { model_name: 'claude-secret' },
      ]);
    });

    it('returns an empty list when the connection has no manual models', async () => {
      service = await buildService([makeProvider({ manual_models: null })]);
      expect(await service.list('agent-1', 'anthropic', 'api_key')).toEqual([]);
    });
  });

  /* ── add ── */

  describe('add', () => {
    it('persists the manual model on the connection', async () => {
      const row = makeProvider({ manual_models: [] });
      service = await buildService([row]);

      const result = await service.add('agent-1', 'anthropic', 'api_key', {
        model_name: 'claude-secret',
      });

      expect(result).toEqual({ model_name: 'claude-secret' });
      expect(row.manual_models).toEqual([{ model_name: 'claude-secret' }]);
      expect(savedRows).toContain(row);
    });

    it('persists optional pricing, context window, and parameter schema reference when provided', async () => {
      const row = makeProvider({ manual_models: [] });
      service = await buildService([row]);

      await service.add('agent-1', 'anthropic', 'api_key', {
        model_name: 'claude-secret',
        input_price_per_million_tokens: 3,
        output_price_per_million_tokens: 15,
        context_window: 200000,
        param_schema_ref: {
          provider: 'anthropic',
          authType: 'api_key',
          model: 'claude-sonnet-4-6',
        },
      });

      expect(row.manual_models).toEqual([
        {
          model_name: 'claude-secret',
          input_price_per_million_tokens: 3,
          output_price_per_million_tokens: 15,
          context_window: 200000,
          param_schema_ref: {
            provider: 'anthropic',
            authType: 'api_key',
            model: 'claude-sonnet-4-6',
          },
        },
      ]);
    });

    it('throws NotFound when the provider is not connected', async () => {
      service = await buildService([]);

      await expect(
        service.add('agent-1', 'anthropic', 'api_key', { model_name: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(savedRows).toHaveLength(0);
    });

    it('rejects shadowing a model the provider genuinely serves', async () => {
      const row = makeProvider({
        cached_models: [{ id: 'claude-opus' } as DiscoveredModel],
      });
      service = await buildService([row]);

      await expect(
        service.add('agent-1', 'anthropic', 'api_key', { model_name: 'claude-opus' }),
      ).rejects.toThrow(BadRequestException);
      expect(row.manual_models).toBeNull();
      expect(savedRows).toHaveLength(0);
    });

    it('is idempotent: re-adding an existing manual model is a no-op', async () => {
      const row = makeProvider({
        manual_models: [{ model_name: 'claude-secret' }],
      });
      service = await buildService([row]);

      const result = await service.add('agent-1', 'anthropic', 'api_key', {
        model_name: 'claude-secret',
      });

      expect(result).toEqual({ model_name: 'claude-secret' });
      expect(row.manual_models).toEqual([{ model_name: 'claude-secret' }]);
      expect(savedRows).toHaveLength(0);
      expect(refreshCalls).toHaveLength(0);
    });

    it('stays idempotent even after a refresh merged the manual model into cached_models', async () => {
      const row = makeProvider({
        manual_models: [{ model_name: 'claude-secret' }],
        cached_models: [
          { id: 'claude-opus' } as DiscoveredModel,
          { id: 'claude-secret', manual: true } as DiscoveredModel,
        ],
      });
      service = await buildService([row]);

      await expect(
        service.add('agent-1', 'anthropic', 'api_key', { model_name: 'claude-secret' }),
      ).resolves.toEqual({ model_name: 'claude-secret' });
      expect(savedRows).toHaveLength(0);
    });

    it('triggers a refresh and tier recalculation on a genuine add', async () => {
      service = await buildService([makeProvider({ manual_models: [] })]);

      await service.add('agent-1', 'anthropic', 'api_key', { model_name: 'new' });

      expect(refreshCalls).toEqual([{ agent: 'agent-1', provider: 'anthropic', auth: 'api_key' }]);
      expect(recalcCalls).toEqual(['agent-1']);
    });

    it('rejects a schema source that is not in the catalog', async () => {
      service = await buildService([makeProvider({ manual_models: [] })]);
      catalogSpecs = [];

      await expect(
        service.add('agent-1', 'anthropic', 'api_key', {
          model_name: 'new',
          param_schema_ref: { provider: 'missing', authType: 'api_key', model: 'ghost' },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(savedRows).toHaveLength(0);
    });
  });

  /* ── updateSettings ── */

  describe('updateSettings', () => {
    it('updates schema source and custom JSON defaults on manual and cached model entries', async () => {
      const row = makeProvider({
        manual_models: [{ model_name: 'glm-5.2' }],
        cached_models: [{ id: 'glm-5.2', manual: true } as DiscoveredModel],
      });
      service = await buildService([row]);

      const result = await service.updateSettings('agent-1', 'anthropic', 'api_key', 'glm-5.2', {
        param_schema_ref: { provider: 'zai', authType: 'api_key', model: 'glm-5.1' },
        param_defaults: { temperature: 0.2, vendor: { reasoning: true } },
      });

      expect(result).toEqual({
        model_name: 'glm-5.2',
        param_schema_ref: { provider: 'zai', authType: 'api_key', model: 'glm-5.1' },
        param_defaults: { temperature: 0.2, vendor: { reasoning: true } },
      });
      expect(row.manual_models).toEqual([result]);
      expect(row.cached_models).toEqual([
        {
          id: 'glm-5.2',
          manual: true,
          paramSchemaRef: { provider: 'zai', authType: 'api_key', model: 'glm-5.1' },
          paramDefaults: { temperature: 0.2, vendor: { reasoning: true } },
        },
      ]);
      expect(savedRows).toContain(row);
      expect(refreshCalls).toHaveLength(0);
      expect(recalcCalls).toHaveLength(0);
      expect(invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('clears schema source and custom JSON defaults when null is saved', async () => {
      const row = makeProvider({
        manual_models: [
          {
            model_name: 'glm-5.2',
            param_schema_ref: { provider: 'zai', authType: 'api_key', model: 'glm-5.1' },
            param_defaults: { temperature: 0.2 },
          },
        ],
      });
      service = await buildService([row]);

      await service.updateSettings('agent-1', 'anthropic', 'api_key', 'glm-5.2', {
        param_schema_ref: null,
        param_defaults: null,
      });

      expect(row.manual_models).toEqual([
        { model_name: 'glm-5.2', param_schema_ref: null, param_defaults: null },
      ]);
    });
  });

  /* ── remove ── */

  describe('remove', () => {
    it('drops the manual model from the connection', async () => {
      const row = makeProvider({
        manual_models: [{ model_name: 'claude-secret' }, { model_name: 'claude-other' }],
      });
      service = await buildService([row]);

      await service.remove('agent-1', 'anthropic', 'api_key', 'claude-secret');

      expect(row.manual_models).toEqual([{ model_name: 'claude-other' }]);
      expect(savedRows).toContain(row);
    });

    it('matches the model id case-insensitively', async () => {
      const row = makeProvider({
        manual_models: [{ model_name: 'claude-secret' }],
      });
      service = await buildService([row]);

      await service.remove('agent-1', 'anthropic', 'api_key', 'CLAUDE-SECRET');

      expect(row.manual_models).toEqual([]);
    });

    it('is a no-op (no save, no refresh) when the model is not manual', async () => {
      const row = makeProvider({
        manual_models: [{ model_name: 'claude-secret' }],
      });
      service = await buildService([row]);

      await service.remove('agent-1', 'anthropic', 'api_key', 'claude-opus');

      expect(row.manual_models).toEqual([{ model_name: 'claude-secret' }]);
      expect(savedRows).toHaveLength(0);
      expect(refreshCalls).toHaveLength(0);
    });
  });
});
