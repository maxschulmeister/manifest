import { BadRequestException } from '@nestjs/common';
import type { ModelAliasClassification } from 'manifest-shared';
import { formatManifestError } from '../common/errors/error-codes';
import type { ResolveResponse } from './dto/resolve-response';
import type { RoutingAliasService } from './routing-alias.service';

export async function parseModelAliasFromBody(
  body: Record<string, unknown>,
  agentId: string,
  deps: {
    routingAliasService: Pick<RoutingAliasService, 'classifyModel' | 'listAcceptedModelIds'>;
  },
): Promise<ModelAliasClassification> {
  const model = body.model;
  if (model === undefined) return { kind: 'auto' };
  if (typeof model !== 'string' || model.length === 0) {
    throw new BadRequestException(
      formatManifestError('M410', {
        model: model === null ? '' : String(model),
        aliases: (await deps.routingAliasService.listAcceptedModelIds(agentId)).join(', '),
      }),
    );
  }

  const classified = await deps.routingAliasService.classifyModel(agentId, model);
  if (classified) return classified;

  throw new BadRequestException(
    formatManifestError('M410', {
      model,
      aliases: (await deps.routingAliasService.listAcceptedModelIds(agentId)).join(', '),
    }),
  );
}

export function modelAliasLabel(
  alias: Exclude<ModelAliasClassification, { kind: 'auto' }>,
): string {
  if (alias.kind === 'tier') return alias.tier;
  if (alias.kind === 'specificity') return alias.category.replace(/_/g, '-');
  return alias.id;
}

export function assertAliasRouteConfigured(
  alias: string,
  resolved: ResolveResponse,
  dashboardUrl: string,
): void {
  if (!resolved.route) {
    throw new BadRequestException(formatManifestError('M411', { alias, dashboardUrl }));
  }
}
