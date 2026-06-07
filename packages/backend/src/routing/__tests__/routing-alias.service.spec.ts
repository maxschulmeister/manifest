import { RoutingAliasService } from '../routing-alias.service';
import type { Repository } from 'typeorm';
import type { Agent } from '../../entities/agent.entity';
import type { TierService } from '../routing-core/tier.service';
import type { SpecificityService } from '../routing-core/specificity.service';
import type { HeaderTierService } from '../header-tiers/header-tier.service';

describe('RoutingAliasService', () => {
  let svc: RoutingAliasService;
  let agentRepo: jest.Mocked<Pick<Repository<Agent>, 'findOne'>>;
  let tierService: jest.Mocked<Pick<TierService, 'getTiers'>>;
  let specificityService: jest.Mocked<Pick<SpecificityService, 'getActiveAssignments'>>;
  let headerTierService: jest.Mocked<Pick<HeaderTierService, 'list'>>;

  beforeEach(() => {
    agentRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: true }),
    };
    tierService = { getTiers: jest.fn().mockResolvedValue([]) };
    specificityService = { getActiveAssignments: jest.fn().mockResolvedValue([]) };
    headerTierService = { list: jest.fn().mockResolvedValue([]) };
    svc = new RoutingAliasService(
      agentRepo as unknown as Repository<Agent>,
      tierService as unknown as TierService,
      specificityService as unknown as SpecificityService,
      headerTierService as unknown as HeaderTierService,
    );
  });

  it('lists routable builtin tiers and specificity aliases plus custom tier slugs', async () => {
    tierService.getTiers.mockResolvedValue([
      {
        tier: 'simple',
        override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
        auto_assigned_route: null,
      },
      { tier: 'complex', override_route: null, auto_assigned_route: null },
    ] as never);
    specificityService.getActiveAssignments.mockResolvedValue([
      {
        category: 'web_browsing',
        is_active: true,
        override_route: { provider: 'anthropic', authType: 'api_key', model: 'claude-sonnet-4' },
        auto_assigned_route: null,
      },
      { category: 'coding', is_active: true, override_route: null, auto_assigned_route: null },
    ] as never);
    headerTierService.list.mockResolvedValue([
      {
        id: 'ht-fast',
        name: 'FastTier',
        enabled: true,
        override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
      },
      { id: 'ht-empty', name: 'Empty', enabled: true, override_route: null },
      {
        id: 'ht-off',
        name: 'Off',
        enabled: false,
        override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
      },
    ] as never);

    await expect(svc.listRoutableModelIds('agent-1')).resolves.toEqual([
      'auto',
      'simple',
      'web-browsing',
      'fast-tier',
    ]);
  });

  it('classifies static model values without requiring a configured route', async () => {
    await expect(svc.classifyModel('agent-1', 'reasoning')).resolves.toEqual({
      kind: 'tier',
      tier: 'reasoning',
    });
    await expect(svc.classifyModel('agent-1', 'coding')).resolves.toEqual({
      kind: 'specificity',
      category: 'coding',
    });
  });

  it('classifies enabled custom tiers by kebab-case names', async () => {
    headerTierService.list.mockResolvedValue([
      { id: 'ht-fast', name: 'FastLane', enabled: true, override_route: null },
    ] as never);

    await expect(svc.classifyModel('agent-1', 'fast-lane')).resolves.toEqual({
      kind: 'header_tier',
      id: 'ht-fast',
    });
    await expect(svc.classifyModel('agent-1', 'ht-fast')).resolves.toBeNull();
  });
});
