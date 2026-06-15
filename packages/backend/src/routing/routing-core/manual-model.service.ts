import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProvider } from '../../entities/user-provider.entity';
import type { CustomProviderModel } from '../../entities/custom-provider.entity';
import type { AuthType } from 'manifest-shared';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { ProviderService } from './provider.service';
import { RoutingCacheService } from './routing-cache.service';
import { ManualModelDto, ManualModelSettingsDto, ParamSchemaRefDto } from '../dto/manual-model.dto';
import { ProviderParamSpecService } from './provider-param-spec.service';

/**
 * Manages operator-added models for integrated providers — models the
 * provider's `/models` endpoint omits but the operator knows are reachable.
 *
 * Manual models live on `user_providers.manual_models` and are merged into
 * `cached_models` by `discoverModels()` (via `supplementWithManualModels`),
 * so they persist across refresh and flow through the standard routing /
 * tier / proxy path with no special handling.
 *
 * Writes target every active row for `(agent, provider, auth_type)` so that
 * a future refresh of any individual key still includes the manual models,
 * then re-runs discovery on one row (the merged list surfaces immediately
 * via `getModelsForAgent` dedup) and recalculates tiers.
 */
@Injectable()
export class ManualModelService {
  constructor(
    @InjectRepository(UserProvider)
    private readonly providerRepo: Repository<UserProvider>,
    private readonly discovery: ModelDiscoveryService,
    private readonly providerService: ProviderService,
    private readonly routingCache: RoutingCacheService,
    private readonly providerParamSpecs: ProviderParamSpecService,
  ) {}

  /** Manual models saved on the active connection for this provider. */
  async list(
    agentId: string,
    provider: string,
    authType: AuthType,
  ): Promise<CustomProviderModel[]> {
    const rows = await this.activeRows(agentId, provider, authType);
    if (rows.length === 0) return [];
    const manual = rows[0].manual_models;
    return Array.isArray(manual) ? manual : [];
  }

  /**
   * Add a manual model to every active row for the connection, then refresh
   * discovery so the model appears in the merged list and tiers pick it up.
   */
  async add(
    agentId: string,
    provider: string,
    authType: AuthType,
    dto: ManualModelDto,
  ): Promise<CustomProviderModel> {
    const rows = await this.activeRows(agentId, provider, authType);
    if (rows.length === 0) {
      throw new NotFoundException(
        `Provider ${provider} (${authType}) is not connected for this agent`,
      );
    }

    await this.assertValidSchemaRef(dto.param_schema_ref);

    // Idempotent: re-adding an existing manual model is a silent no-op so the
    // operator doesn't see a spurious error after a refresh has merged it into
    // cached_models.
    const existingManual = Array.isArray(rows[0].manual_models) ? rows[0].manual_models : [];
    if (existingManual.some((m) => m.model_name.toLowerCase() === dto.model_name.toLowerCase())) {
      return {
        model_name: dto.model_name,
        ...(dto.input_price_per_million_tokens != null
          ? { input_price_per_million_tokens: dto.input_price_per_million_tokens }
          : {}),
        ...(dto.output_price_per_million_tokens != null
          ? { output_price_per_million_tokens: dto.output_price_per_million_tokens }
          : {}),
        ...(dto.context_window != null ? { context_window: dto.context_window } : {}),
        ...(dto.param_schema_ref ? { param_schema_ref: dto.param_schema_ref } : {}),
        ...(dto.param_defaults ? { param_defaults: dto.param_defaults } : {}),
      };
    }

    // Reject shadowing a model the provider genuinely serves. cached_models is
    // the merged discovered ∪ manual list, so exclude manual entries first —
    // otherwise re-adding a manual model after a refresh would be mis-flagged.
    const servedIds = new Set(
      rows
        .flatMap((r) => (Array.isArray(r.cached_models) ? r.cached_models : []))
        .filter((m) => !m.manual)
        .map((m) => m.id.toLowerCase()),
    );
    if (servedIds.has(dto.model_name.toLowerCase())) {
      throw new BadRequestException(`Model "${dto.model_name}" is already served by ${provider}`);
    }

    const entry: CustomProviderModel = { model_name: dto.model_name };
    if (dto.input_price_per_million_tokens != null)
      entry.input_price_per_million_tokens = dto.input_price_per_million_tokens;
    if (dto.output_price_per_million_tokens != null)
      entry.output_price_per_million_tokens = dto.output_price_per_million_tokens;
    if (dto.context_window != null) entry.context_window = dto.context_window;
    if (dto.param_schema_ref) entry.param_schema_ref = dto.param_schema_ref;
    if (dto.param_defaults) entry.param_defaults = dto.param_defaults;

    for (const row of rows) {
      const current = Array.isArray(row.manual_models) ? row.manual_models : [];
      row.manual_models = [...current, entry];
      await this.providerRepo.save(row);
    }

    const refresh = await this.discovery.refreshProvider(agentId, provider, authType);
    if (!refresh.ok) {
      throw new BadRequestException(refresh.error ?? 'Model refresh failed');
    }
    await this.providerService.recalculateTiers(agentId);

    return entry;
  }

  /** Update settings metadata for an existing manual model. */
  async updateSettings(
    agentId: string,
    provider: string,
    authType: AuthType,
    modelId: string,
    dto: ManualModelSettingsDto,
  ): Promise<CustomProviderModel> {
    const rows = await this.activeRows(agentId, provider, authType);
    if (rows.length === 0) {
      throw new NotFoundException(
        `Provider ${provider} (${authType}) is not connected for this agent`,
      );
    }

    await this.assertValidSchemaRef(dto.param_schema_ref);

    let updated: CustomProviderModel | null = null;
    for (const row of rows) {
      const manual = Array.isArray(row.manual_models) ? row.manual_models : [];
      const index = manual.findIndex((m) => m.model_name.toLowerCase() === modelId.toLowerCase());
      if (index === -1) continue;

      const next = { ...manual[index]! };
      if ('param_schema_ref' in dto) next.param_schema_ref = dto.param_schema_ref ?? null;
      if ('param_defaults' in dto) next.param_defaults = dto.param_defaults ?? null;
      row.manual_models = manual.map((item, i) => (i === index ? next : item));

      if (Array.isArray(row.cached_models)) {
        row.cached_models = row.cached_models.map((model) =>
          model.manual === true && model.id.toLowerCase() === modelId.toLowerCase()
            ? {
                ...model,
                paramSchemaRef: next.param_schema_ref ?? null,
                paramDefaults: next.param_defaults ?? null,
              }
            : model,
        );
      }

      await this.providerRepo.save(row);
      updated = next;
    }

    if (!updated) throw new NotFoundException(`Manual model "${modelId}" not found`);
    this.routingCache.invalidateAgent(agentId);
    return updated;
  }

  /**
   * Remove a manual model from every active row for the connection. A model
   * that was never manual (e.g. one the provider genuinely serves) is a
   * no-op — the operator can't delete a real model this way.
   */
  async remove(
    agentId: string,
    provider: string,
    authType: AuthType,
    modelId: string,
  ): Promise<void> {
    const rows = await this.activeRows(agentId, provider, authType);
    let changed = false;
    for (const row of rows) {
      if (!Array.isArray(row.manual_models) || row.manual_models.length === 0) continue;
      const before = row.manual_models.length;
      row.manual_models = row.manual_models.filter(
        (m) => m.model_name.toLowerCase() !== modelId.toLowerCase(),
      );
      if (row.manual_models.length !== before) {
        changed = true;
        await this.providerRepo.save(row);
      }
    }

    if (!changed) return;

    await this.discovery.refreshProvider(agentId, provider, authType);
    await this.providerService.recalculateTiers(agentId);
  }

  private async activeRows(
    agentId: string,
    provider: string,
    authType: AuthType,
  ): Promise<UserProvider[]> {
    return this.providerRepo.find({
      where: { agent_id: agentId, provider, auth_type: authType, is_active: true },
    });
  }

  private assertValidSchemaRef(ref: ParamSchemaRefDto | null | undefined): void {
    if (!ref) return;
    const specs = this.providerParamSpecs.getCatalogSpecs(ref.provider, ref.authType, ref.model);
    if (specs.length === 0) {
      throw new BadRequestException(`No parameter schema found for ${ref.provider}/${ref.model}`);
    }
  }
}
