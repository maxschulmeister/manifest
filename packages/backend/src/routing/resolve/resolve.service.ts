import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IncomingHttpHeaders } from 'http';
import { TierService } from '../routing-core/tier.service';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import { SpecificityService } from '../routing-core/specificity.service';
import { SpecificityPenaltyService } from '../routing-core/specificity-penalty.service';
import { HeaderTierService } from '../header-tiers/header-tier.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { readOverrideRoute, readOverrideTarget } from '../routing-core/route-helpers';
import { effectiveRoutesForResponseMode } from '../routing-core/response-mode-guard';
import { scoreRequest, ScorerInput, MomentumInput, scanMessages } from '../../scoring';
import { ResolveResponse } from '../dto/resolve-response';
import { inferProviderFromModelName } from '../../common/utils/provider-aliases';
import { Agent } from '../../entities/agent.entity';
import {
  DEFAULT_RESPONSE_MODE,
  DEFAULT_OUTPUT_MODALITY,
  isFallbackRouteTargetArray,
  isHeaderTierRouteTarget,
  isModelRoute,
} from 'manifest-shared';
import type {
  AuthType,
  ModelRoute,
  ResponseMode,
  OutputModality,
  SpecificityCategory,
  TierSlot,
} from 'manifest-shared';
import type { HeaderTier } from '../../entities/header-tier.entity';
import type { TierAssignment } from '../../entities/tier-assignment.entity';
import type { SpecificityAssignment } from '../../entities/specificity-assignment.entity';

/**
 * When specificity detection is below this confidence, skip specificity
 * routing and fall through to the complexity tier. Low-confidence detections
 * are the ones that misrouted coding sessions to web_browsing (discussion
 * #1613) — the safer call is to route by complexity instead of committing to
 * an ambiguous specificity category. Kept below the typical
 * single-strong-anchor confidence (0.33 for web_browsing at threshold 3) but
 * above the score-equals-threshold minimum, so clean 2-signal detections
 * (keyword + URL, keyword + tool) still pass.
 */
const MIN_SPECIFICITY_CONFIDENCE = 0.4;

interface ResolvedRouteChain {
  primaryRoute: ModelRoute | null;
  fallbackRoutes: ModelRoute[] | null;
}

@Injectable()
export class ResolveService {
  private readonly logger = new Logger(ResolveService.name);

  constructor(
    private readonly tierService: TierService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly specificityService: SpecificityService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly discoveryService: ModelDiscoveryService,
    private readonly penaltyService: SpecificityPenaltyService,
    private readonly headerTierService: HeaderTierService,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
  ) {}

  async resolve(
    agentId: string,
    messages: ScorerInput['messages'],
    tools?: ScorerInput['tools'],
    toolChoice?: unknown,
    maxTokens?: number,
    recentTiers?: MomentumInput['recentTiers'],
    specificityOverride?: string,
    recentCategories?: readonly SpecificityCategory[],
    headers?: IncomingHttpHeaders,
  ): Promise<ResolveResponse> {
    if (headers) {
      const headerTierResult = await this.resolveHeaderTier(agentId, headers);
      if (headerTierResult) return headerTierResult;
    }

    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (agent && !agent.complexity_routing_enabled) {
      return this.resolveForTier(agentId, 'default', 'default');
    }

    const specificityResult = await this.resolveSpecificity(
      agentId,
      messages,
      tools,
      specificityOverride,
      recentCategories,
    );
    if (specificityResult) return specificityResult;

    const input: ScorerInput = { messages, tools, tool_choice: toolChoice, max_tokens: maxTokens };
    const momentum: MomentumInput | undefined =
      recentTiers && recentTiers.length > 0 ? { recentTiers } : undefined;

    const result = scoreRequest(input, undefined, momentum);

    const tiers = await this.tierService.getTiers(agentId);
    const assignment = tiers.find((t) => t.tier === result.tier);

    if (!assignment) {
      this.logger.warn(
        `No tier assignment found for agent=${agentId} tier=${result.tier} ` +
          `(available tiers: ${tiers.map((t) => t.tier).join(', ') || 'none'})`,
      );
      // Final catch-all: fall back to the default tier so the request still
      // resolves a model instead of 500ing when a scored tier is missing.
      return this.resolveForTier(agentId, 'default', 'default');
    }

    const outputModality = outputModalityFor(assignment);
    const responseMode = responseModeFor(assignment);
    const assignmentFallbackRoutes = await this.resolveFallbackTargets(
      agentId,
      assignment.fallback_routes,
    );
    const routeChain = await this.buildResolvedRouteChain(agentId, assignment);
    const effectiveRoutes = effectiveRoutesForResponseMode(
      responseMode,
      routeChain.primaryRoute,
      concatRoutes(routeChain.fallbackRoutes, assignmentFallbackRoutes),
    );
    if (!effectiveRoutes.primaryRoute) {
      this.logger.warn(
        `No route resolved for agent=${agentId} tier=${result.tier} ` +
          `(override=${routeTargetLabel(assignment.override_route)} ` +
          `auto=${assignment.auto_assigned_route?.model ?? 'null'})`,
      );
      return {
        tier: result.tier,
        route: null,
        fallback_routes: effectiveRoutes.fallbackRoutes,
        output_modality: outputModality,
        response_mode: responseMode,
        confidence: result.confidence,
        score: result.score,
        reason: result.reason,
      };
    }

    return {
      tier: result.tier,
      route: effectiveRoutes.primaryRoute,
      fallback_routes: effectiveRoutes.fallbackRoutes,
      output_modality: outputModality,
      response_mode: responseMode,
      confidence: result.confidence,
      score: result.score,
      reason: result.reason,
    };
  }

  async resolveForTier(
    agentId: string,
    tier: TierSlot,
    reason: 'heartbeat' | 'default' | 'model_alias' = 'heartbeat',
  ): Promise<ResolveResponse> {
    const tiers = await this.tierService.getTiers(agentId);
    const assignment = tiers.find((t) => t.tier === tier);

    if (!assignment) {
      return {
        tier,
        route: null,
        fallback_routes: null,
        output_modality: DEFAULT_OUTPUT_MODALITY,
        response_mode: DEFAULT_RESPONSE_MODE,
        confidence: 1,
        score: 0,
        reason,
      };
    }

    const outputModality = outputModalityFor(assignment);
    const responseMode = responseModeFor(assignment);
    const assignmentFallbackRoutes = await this.resolveFallbackTargets(
      agentId,
      assignment.fallback_routes,
    );
    const routeChain = await this.buildResolvedRouteChain(agentId, assignment);
    const effectiveRoutes = effectiveRoutesForResponseMode(
      responseMode,
      routeChain.primaryRoute,
      concatRoutes(routeChain.fallbackRoutes, assignmentFallbackRoutes),
    );
    return {
      tier,
      route: effectiveRoutes.primaryRoute,
      fallback_routes: effectiveRoutes.fallbackRoutes,
      output_modality: outputModality,
      response_mode: responseMode,
      confidence: 1,
      score: 0,
      reason,
    };
  }

  private async resolveHeaderTier(
    agentId: string,
    headers: IncomingHttpHeaders,
  ): Promise<ResolveResponse | null> {
    const allTiers = await this.headerTierService.list(agentId);
    const tiers = allTiers.filter((t) => t.enabled);
    if (tiers.length === 0) return null;

    const match = tiers.find((t) => matchesHeaderRule(headers, t));
    if (!match) return null;

    return this.buildHeaderTierResponse(agentId, match, 'header-match');
  }

  async resolveForHeaderTier(agentId: string, headerTierId: string): Promise<ResolveResponse> {
    const allTiers = await this.headerTierService.list(agentId);
    const match = allTiers.find((t) => t.id === headerTierId && t.enabled);
    if (!match) {
      return {
        tier: 'standard',
        route: null,
        fallback_routes: null,
        output_modality: DEFAULT_OUTPUT_MODALITY,
        response_mode: DEFAULT_RESPONSE_MODE,
        confidence: 1,
        score: 0,
        reason: 'model_alias',
      };
    }

    const built = await this.buildHeaderTierResponse(agentId, match, 'model_alias');
    if (built) return built;

    return {
      tier: 'standard',
      route: null,
      fallback_routes: await this.resolveFallbackTargets(agentId, match.fallback_routes),
      output_modality: outputModalityFor(match),
      response_mode: responseModeFor(match),
      confidence: 1,
      score: 0,
      reason: 'model_alias',
      header_tier_id: match.id,
      header_tier_name: match.name,
      header_tier_color: match.badge_color,
    };
  }

  async resolveForSpecificity(
    agentId: string,
    category: SpecificityCategory,
  ): Promise<ResolveResponse> {
    const active = await this.specificityService.getActiveAssignments(agentId);
    const assignment = active.find((a) => a.category === category);
    if (!assignment) {
      return {
        tier: 'standard',
        route: null,
        fallback_routes: null,
        output_modality: DEFAULT_OUTPUT_MODALITY,
        response_mode: DEFAULT_RESPONSE_MODE,
        confidence: 1,
        score: 0,
        reason: 'model_alias',
        specificity_category: category,
      };
    }

    const routeChain = await this.buildResolvedRouteChain(agentId, assignment);
    const outputModality = outputModalityFor(assignment);
    const responseMode = responseModeFor(assignment);
    const assignmentFallbackRoutes = await this.resolveFallbackTargets(
      agentId,
      assignment.fallback_routes,
    );
    const effectiveRoutes = effectiveRoutesForResponseMode(
      responseMode,
      routeChain.primaryRoute,
      concatRoutes(routeChain.fallbackRoutes, assignmentFallbackRoutes),
    );

    return {
      tier: 'standard',
      route: effectiveRoutes.primaryRoute,
      fallback_routes: effectiveRoutes.fallbackRoutes,
      output_modality: outputModality,
      response_mode: responseMode,
      confidence: 1,
      score: 0,
      reason: 'model_alias',
      specificity_category: category,
    };
  }

  private async buildHeaderTierResponse(
    agentId: string,
    match: HeaderTier,
    reason: 'header-match' | 'model_alias',
  ): Promise<ResolveResponse | null> {
    const overrideRoute = readOverrideRoute(match);
    if (!overrideRoute) {
      if (reason === 'header-match') {
        this.logger.debug(
          `Header tier "${match.name}" matched but has no model configured — falling through`,
        );
      }
      return null;
    }

    if (!(await this.providerKeyService.isModelAvailable(agentId, overrideRoute.model))) {
      this.logger.warn(
        `Header tier "${match.name}" override ${overrideRoute.model} is unavailable ` +
          `for agent=${agentId}; falling through to existing routing`,
      );
      return null;
    }

    const provider =
      overrideRoute.provider || (await this.resolveProviderForModel(agentId, overrideRoute.model));
    const authType: AuthType =
      overrideRoute.authType ??
      (await this.providerKeyService.getAuthType(agentId, provider ?? ''));
    const baseRoute: ModelRoute | null =
      provider && authType
        ? { provider, authType, model: overrideRoute.model, keyLabel: overrideRoute.keyLabel }
        : null;
    const route = baseRoute ? await this.enrichRouteKeyLabel(agentId, baseRoute) : null;

    const outputModality = outputModalityFor(match);
    const responseMode = responseModeFor(match);
    const fallbackRoutes = await this.resolveFallbackTargets(agentId, match.fallback_routes);
    const effectiveRoutes = effectiveRoutesForResponseMode(responseMode, route, fallbackRoutes);

    return {
      tier: 'standard',
      route: effectiveRoutes.primaryRoute,
      fallback_routes: effectiveRoutes.fallbackRoutes,
      output_modality: outputModality,
      response_mode: responseMode,
      confidence: 1,
      score: 0,
      reason,
      header_tier_id: match.id,
      header_tier_name: match.name,
      header_tier_color: match.badge_color,
    };
  }

  private async resolveSpecificity(
    agentId: string,
    messages: ScorerInput['messages'],
    tools?: ScorerInput['tools'],
    headerOverride?: string,
    recentCategories?: readonly SpecificityCategory[],
  ): Promise<ResolveResponse | null> {
    const active = await this.specificityService.getActiveAssignments(agentId);
    if (active.length === 0) return null;

    const penalties = await this.penaltyService.getPenaltiesForAgent(agentId);
    const detected = scanMessages(
      messages,
      tools,
      headerOverride,
      recentCategories,
      penalties.size > 0 ? penalties : undefined,
    );
    if (!detected) return null;

    // Confidence gate: a weak detection (single keyword match, no corroborating
    // signal) is the one that misroutes coding sessions. Fall through to
    // complexity routing instead of committing to the ambiguous category.
    // Header overrides bypass the gate because they are explicit user intent.
    if (!headerOverride && detected.confidence < MIN_SPECIFICITY_CONFIDENCE) {
      this.logger.debug(
        `Specificity detected=${detected.category} ` +
          `confidence=${detected.confidence.toFixed(2)} below ${MIN_SPECIFICITY_CONFIDENCE} — ` +
          `falling through to complexity routing`,
      );
      return null;
    }

    const assignment = active.find((a) => a.category === detected.category);
    if (!assignment) return null;

    const routeChain = await this.buildResolvedRouteChain(agentId, assignment, {
      unavailableOverride: 'null',
      logLabel: 'Specificity override',
    });
    if (!routeChain.primaryRoute) return null;

    const outputModality = outputModalityFor(assignment);
    const responseMode = responseModeFor(assignment);
    const assignmentFallbackRoutes = await this.resolveFallbackTargets(
      agentId,
      assignment.fallback_routes,
    );
    const effectiveRoutes = effectiveRoutesForResponseMode(
      responseMode,
      routeChain.primaryRoute,
      concatRoutes(routeChain.fallbackRoutes, assignmentFallbackRoutes),
    );

    return {
      tier: 'standard',
      route: effectiveRoutes.primaryRoute,
      fallback_routes: effectiveRoutes.fallbackRoutes,
      output_modality: outputModality,
      response_mode: responseMode,
      confidence: detected.confidence,
      score: 0,
      reason: 'specificity',
      specificity_category: detected.category,
    };
  }

  private async resolveFallbackTargets(
    agentId: string,
    targets: unknown,
  ): Promise<ModelRoute[] | null> {
    if (targets == null) return null;
    if (!isFallbackRouteTargetArray(targets)) return null;

    const resolved: ModelRoute[] = [];
    for (const target of targets) {
      if (isModelRoute(target)) {
        resolved.push(target);
        continue;
      }
      const expanded = await this.resolveHeaderTierFallback(agentId, target.id);
      if (expanded) resolved.push(...expanded);
    }
    return resolved.length > 0 ? resolved : null;
  }

  private async resolveHeaderTierFallback(
    agentId: string,
    headerTierId: string,
  ): Promise<ModelRoute[] | null> {
    const chain = await this.resolveHeaderTierChain(agentId, headerTierId, false);
    if (!chain?.primaryRoute) return null;
    return chain.fallbackRoutes
      ? [chain.primaryRoute, ...chain.fallbackRoutes]
      : [chain.primaryRoute];
  }

  private async resolveHeaderTierPrimary(
    agentId: string,
    headerTierId: string,
  ): Promise<ResolvedRouteChain | null> {
    return this.resolveHeaderTierChain(agentId, headerTierId, true);
  }

  private async resolveHeaderTierChain(
    agentId: string,
    headerTierId: string,
    requireAvailablePrimary: boolean,
  ): Promise<ResolvedRouteChain | null> {
    const tiers = await this.headerTierService.list(agentId);
    const tier = tiers.find((t) => t.id === headerTierId && t.enabled);
    const override = tier ? readOverrideRoute(tier) : null;
    if (!tier || !override) return null;
    if (
      requireAvailablePrimary &&
      !(await this.providerKeyService.isModelAvailable(agentId, override.model))
    ) {
      return null;
    }

    const route = await this.enrichRouteKeyLabel(agentId, override);
    const fallbackRoutes = await this.resolveFallbackTargets(agentId, tier.fallback_routes);
    return { primaryRoute: route, fallbackRoutes };
  }

  /**
   * Build the resolved route chain for a tier assignment. Header-tier primary
   * targets expand to their own primary route plus custom-tier fallbacks;
   * assignment-level fallbacks are appended by the caller.
   */
  private async buildResolvedRouteChain(
    agentId: string,
    assignment: TierAssignment | SpecificityAssignment,
    options: { unavailableOverride?: 'auto' | 'null'; logLabel?: string } = {},
  ): Promise<ResolvedRouteChain> {
    const override = readOverrideTarget(assignment);
    if (override) {
      if (isModelRoute(override)) {
        if (await this.providerKeyService.isModelAvailable(agentId, override.model)) {
          return {
            primaryRoute: await this.enrichRouteKeyLabel(agentId, override),
            fallbackRoutes: null,
          };
        }
        this.logger.warn(
          `${options.logLabel ?? 'Override'} ${override.model} unavailable for agent=${agentId} — ` +
            (options.unavailableOverride === 'null'
              ? 'falling through to tier routing'
              : 'falling back to auto'),
        );
        if (options.unavailableOverride === 'null') {
          return { primaryRoute: null, fallbackRoutes: null };
        }
      } else if (isHeaderTierRouteTarget(override)) {
        const expanded = await this.resolveHeaderTierPrimary(agentId, override.id);
        if (expanded) return expanded;
        this.logger.warn(
          `${options.logLabel ?? 'Override'} header tier ${override.id} unavailable for agent=${agentId} — ` +
            (options.unavailableOverride === 'null'
              ? 'falling through to tier routing'
              : 'falling back to auto'),
        );
        if (options.unavailableOverride === 'null') {
          return { primaryRoute: null, fallbackRoutes: null };
        }
      }
    }

    return assignment.auto_assigned_route
      ? {
          primaryRoute: await this.enrichRouteKeyLabel(agentId, assignment.auto_assigned_route),
          fallbackRoutes: null,
        }
      : { primaryRoute: null, fallbackRoutes: null };
  }

  /**
   * Fill in `route.keyLabel` from the agent's default (priority-0) key for
   * (route.provider, route.authType) when the route doesn't already pin a
   * specific label. The proxy needs a concrete keyLabel to pick the right
   * row in `user_providers`; without this, multi-key users would always hit
   * the first key, ignoring per-tier pins set on auto-assigned routes.
   *
   * authType is taken from the route itself (not from any assignment-level
   * legacy field), so this can't accidentally use the override's authType
   * for an auto-assigned model picked under a different auth mode.
   */
  private async enrichRouteKeyLabel(agentId: string, route: ModelRoute): Promise<ModelRoute> {
    if (route.keyLabel) return route;
    const label = await this.providerKeyService.getDefaultKeyLabel(
      agentId,
      route.provider,
      route.authType,
    );
    return label ? { ...route, keyLabel: label } : route;
  }

  /**
   * Resolve provider for a model that has no explicit provider attached
   * (e.g. legacy header-tier rows where override_route was backfilled with
   * just the model). Used as a fallback only.
   */
  private async resolveProviderForModel(agentId: string, model: string): Promise<string | null> {
    // 1. Slash prefix on the model name when that provider is connected.
    const prefix = inferProviderFromModelName(model);
    if (prefix && (await this.providerKeyService.hasActiveProvider(agentId, prefix))) {
      return prefix;
    }
    // 2. Discovered models cache.
    const discovered = await this.discoveryService.getModelForAgent(agentId, model);
    if (discovered) return discovered.provider;
    // 3. Pricing cache (excluding the OpenRouter aggregator).
    const pricing = this.pricingCache.getByModel(model);
    if (pricing && pricing.provider !== 'OpenRouter') return pricing.provider;
    return null;
  }
}

function matchesHeaderRule(headers: IncomingHttpHeaders, tier: HeaderTier): boolean {
  if (!tier.header_key || !tier.header_value) return false;
  const raw = headers[tier.header_key];
  if (raw == null) return false;
  // Node gives repeated headers as string[]; match if any entry equals the rule.
  if (Array.isArray(raw)) return raw.some((v) => v === tier.header_value);
  return raw === tier.header_value;
}

function outputModalityFor(row: { output_modality?: OutputModality | null }): OutputModality {
  return row.output_modality ?? DEFAULT_OUTPUT_MODALITY;
}

function responseModeFor(row: { response_mode?: ResponseMode | null }): ResponseMode {
  return row.response_mode ?? DEFAULT_RESPONSE_MODE;
}

function concatRoutes(
  first: ModelRoute[] | null | undefined,
  second: ModelRoute[] | null | undefined,
): ModelRoute[] | null {
  const routes = [...(first ?? []), ...(second ?? [])];
  return routes.length > 0 ? routes : null;
}

function routeTargetLabel(target: unknown): string {
  if (isModelRoute(target)) return target.model;
  if (isHeaderTierRouteTarget(target)) return `header_tier:${target.id}`;
  return 'null';
}
