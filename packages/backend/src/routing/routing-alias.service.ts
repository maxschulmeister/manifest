import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  classifyModelAlias,
  DEFAULT_TIER_SLOT,
  getStaticModelAliases,
  SPECIFICITY_CATEGORIES,
  specificityCategoryToAlias,
  TIERS,
  type ModelAliasClassification,
  type TierSlot,
} from 'manifest-shared';
import { Agent } from '../entities/agent.entity';
import { TierService } from './routing-core/tier.service';
import { SpecificityService } from './routing-core/specificity.service';
import { HeaderTierService } from './header-tiers/header-tier.service';
import { effectiveRoute, readOverrideRoute } from './routing-core/route-helpers';

@Injectable()
export class RoutingAliasService {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    private readonly tierService: TierService,
    private readonly specificityService: SpecificityService,
    private readonly headerTierService: HeaderTierService,
  ) {}

  async listRoutableModelIds(agentId: string): Promise<string[]> {
    const ids: string[] = ['auto'];

    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    const tierSlots: readonly TierSlot[] = agent?.complexity_routing_enabled
      ? TIERS
      : [DEFAULT_TIER_SLOT];

    const tierRows = await this.tierService.getTiers(agentId);
    const tierBySlot = new Map(tierRows.map((t) => [t.tier, t]));
    for (const slot of tierSlots) {
      const row = tierBySlot.get(slot);
      if (row && effectiveRoute(row)) ids.push(slot);
    }

    const active = await this.specificityService.getActiveAssignments(agentId);
    const activeByCategory = new Map(active.map((a) => [a.category, a]));
    for (const category of SPECIFICITY_CATEGORIES) {
      const row = activeByCategory.get(category);
      if (row && effectiveRoute(row)) ids.push(specificityCategoryToAlias(category));
    }

    const headerTiers = await this.headerTierService.list(agentId);
    for (const tier of headerTiers) {
      if (tier.enabled && readOverrideRoute(tier)) ids.push(tier.id);
    }

    return ids;
  }

  async listAcceptedModelIds(agentId: string): Promise<string[]> {
    const customIds = (await this.headerTierService.list(agentId))
      .filter((tier) => tier.enabled)
      .map((tier) => tier.id);
    return [...getStaticModelAliases(), ...customIds];
  }

  async classifyModel(agentId: string, model: string): Promise<ModelAliasClassification | null> {
    const staticAlias = classifyModelAlias(model);
    if (staticAlias) return staticAlias;

    const customTier = (await this.headerTierService.list(agentId)).find(
      (tier) => tier.enabled && tier.id === model,
    );
    return customTier ? { kind: 'header_tier', id: customTier.id } : null;
  }
}
