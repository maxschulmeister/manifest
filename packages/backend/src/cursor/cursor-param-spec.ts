import type { ProviderParamSpec, ProviderModelParamSpec } from 'manifest-shared';
import {
  getCursorModelMetadata,
  listCursorModelMetadata,
  type CursorReasoningLevel,
} from './cursor-model-metadata';
import { CURSOR_ROUTE_PARAM_PREFIX } from './cursor-param-mapper';

const CURSOR_PROVIDER = 'cursor';
const CURSOR_AUTH = 'subscription';

function decorateSpec(
  manifestModelId: string,
  spec: Omit<ProviderParamSpec, 'provider' | 'authType' | 'model'>,
): ProviderParamSpec {
  return {
    provider: CURSOR_PROVIDER,
    authType: CURSOR_AUTH,
    model: manifestModelId,
    ...spec,
  };
}

function supportedReasoningLevels(
  metadata: NonNullable<ReturnType<typeof getCursorModelMetadata>>,
): CursorReasoningLevel[] {
  if (!metadata.thinkingLevelMap) return [];
  return (Object.entries(metadata.thinkingLevelMap) as Array<[CursorReasoningLevel, string | null]>)
    .filter(([, value]) => value !== null)
    .map(([level]) => level);
}

function buildReasoningLevelSpec(
  manifestModelId: string,
  metadata: NonNullable<ReturnType<typeof getCursorModelMetadata>>,
): ProviderParamSpec | null {
  const values = supportedReasoningLevels(metadata);
  if (values.length === 0) return null;
  return decorateSpec(manifestModelId, {
    path: `${CURSOR_ROUTE_PARAM_PREFIX}reasoning_level`,
    type: 'enum',
    label: 'Reasoning level',
    group: 'reasoning',
    description: 'Cursor reasoning / effort level for this model.',
    values,
    default: values.includes('medium') ? 'medium' : values[0],
  });
}

function buildFastSpec(
  manifestModelId: string,
  metadata: NonNullable<ReturnType<typeof getCursorModelMetadata>>,
): ProviderParamSpec | null {
  if (!metadata.supportsFast) return null;
  return decorateSpec(manifestModelId, {
    path: `${CURSOR_ROUTE_PARAM_PREFIX}fast`,
    type: 'boolean',
    label: 'Fast mode',
    group: 'provider_metadata',
    description: 'Enable Cursor fast mode when the model supports it.',
    default: metadata.defaultFast,
  });
}

function buildModeSpec(manifestModelId: string): ProviderParamSpec {
  return decorateSpec(manifestModelId, {
    path: `${CURSOR_ROUTE_PARAM_PREFIX}mode`,
    type: 'enum',
    label: 'SDK mode',
    group: 'provider_metadata',
    description: 'Cursor SDK conversation mode.',
    values: ['agent', 'plan'],
    default: 'agent',
  });
}

export function buildCursorParamSpecs(manifestModelId: string): readonly ProviderParamSpec[] {
  const metadata = getCursorModelMetadata(manifestModelId);
  if (!metadata) return [];

  const specs: ProviderParamSpec[] = [buildModeSpec(manifestModelId)];
  const reasoningSpec = buildReasoningLevelSpec(manifestModelId, metadata);
  if (reasoningSpec) specs.push(reasoningSpec);
  const fastSpec = buildFastSpec(manifestModelId, metadata);
  if (fastSpec) specs.push(fastSpec);

  return specs;
}

export function buildCursorParamCatalog(): readonly ProviderModelParamSpec[] {
  return listCursorModelMetadata().map((metadata) => ({
    provider: CURSOR_PROVIDER,
    authType: CURSOR_AUTH,
    model: metadata.manifestModelId,
    params: buildCursorParamSpecs(metadata.manifestModelId),
  }));
}

export function listCursorParamModelIds(): Array<{
  provider: string;
  authType: typeof CURSOR_AUTH;
  model: string;
}> {
  return listCursorModelMetadata()
    .filter((metadata) => buildCursorParamSpecs(metadata.manifestModelId).length > 0)
    .map((metadata) => ({
      provider: CURSOR_PROVIDER,
      authType: CURSOR_AUTH,
      model: metadata.manifestModelId,
    }));
}

export function isCursorProviderModel(
  providerId: string | undefined,
  authType: string | undefined,
  model: string | undefined,
): boolean {
  return (
    providerId?.toLowerCase() === CURSOR_PROVIDER &&
    authType === CURSOR_AUTH &&
    typeof model === 'string' &&
    model.length > 0
  );
}
