import type { ModelListItem, ModelParameterDefinition, ModelParameterValue } from '@cursor/sdk';
import { FALLBACK_MODEL_ITEMS } from './cursor-fallback-models.generated';

const CURSOR_PROVIDER_PREFIX = 'cursor/';

export type CursorReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type CursorThinkingLevelMap = Partial<Record<CursorReasoningLevel, string | null>>;

export interface CursorModelMetadata {
  manifestModelId: string;
  baseModelId: string;
  selectionModelId: string;
  displayName: string;
  defaultParams: ModelParameterValue[];
  context?: string;
  contextWindow: number;
  supportsFast: boolean;
  defaultFast: boolean;
  supportsReasoning: boolean;
  thinkingLevelMap?: CursorThinkingLevelMap;
  parameterIds: {
    context: boolean;
    reasoning: boolean;
    effort: boolean;
    thinking: boolean;
    fast: boolean;
  };
}

const metadataByManifestModelId = new Map<string, CursorModelMetadata>();
const FALLBACK_CONTEXT_WINDOW = 128_000;

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
  return params.map((param) => ({ ...param }));
}

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
  return item.parameters?.find((parameter) => parameter.id === id);
}

function hasBooleanValues(parameter: ModelParameterDefinition | undefined): boolean {
  const values = new Set((parameter?.values ?? []).map((value) => value.value.toLowerCase()));
  return values.has('false') && values.has('true');
}

function getParameterValue(
  parameter: ModelParameterDefinition | undefined,
  lowerValue: string,
): string | null {
  const value = parameter?.values.find((candidate) => candidate.value.toLowerCase() === lowerValue);
  return value?.value ?? null;
}

function getPreferredParameterValue(
  parameter: ModelParameterDefinition | undefined,
  lowerValues: string[],
): string | null {
  for (const value of lowerValues) {
    const candidate = getParameterValue(parameter, value);
    if (candidate) return candidate;
  }
  return null;
}

function mapComparableLevel(
  parameter: ModelParameterDefinition | undefined,
  level: Exclude<CursorReasoningLevel, 'off'>,
): string | null {
  if (level === 'xhigh') {
    return getPreferredParameterValue(parameter, ['xhigh', 'max', 'extra-high']);
  }
  return getParameterValue(parameter, level);
}

function getThinkingLevelMap(item: ModelListItem): CursorThinkingLevelMap | undefined {
  const reasoningParameter = getParameter(item, 'reasoning');
  const effortParameter = getParameter(item, 'effort');
  const thinkingParameter = getParameter(item, 'thinking');
  const valueParameter = effortParameter ?? reasoningParameter ?? thinkingParameter;
  if (!valueParameter) return undefined;

  if (valueParameter.id === 'thinking' && hasBooleanValues(valueParameter)) {
    return {
      off: getParameterValue(valueParameter, 'false'),
      minimal: null,
      low: null,
      medium: null,
      high: getParameterValue(valueParameter, 'true'),
      xhigh: null,
    };
  }

  return {
    off:
      getParameterValue(reasoningParameter, 'none') ??
      getParameterValue(reasoningParameter, 'off') ??
      getParameterValue(thinkingParameter, 'false'),
    minimal: mapComparableLevel(valueParameter, 'minimal'),
    low: mapComparableLevel(valueParameter, 'low'),
    medium: mapComparableLevel(valueParameter, 'medium'),
    high: mapComparableLevel(valueParameter, 'high'),
    xhigh: mapComparableLevel(valueParameter, 'xhigh'),
  };
}

function parseContextWindow(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(amount)) return undefined;
  return Math.round(amount * (unit === 'm' ? 1_000_000 : 1_000));
}

function getDefaultParams(item: ModelListItem): ModelParameterValue[] {
  if (!item.variants?.length) return [];
  const defaultVariant = item.variants.find((variant) => variant.isDefault) ?? item.variants[0];
  return cloneParams(defaultVariant?.params ?? []);
}

function replaceParam(
  params: ModelParameterValue[],
  id: string,
  value: string,
): ModelParameterValue[] {
  let replaced = false;
  const next = params.map((param) => {
    if (param.id !== id) return { ...param };
    replaced = true;
    return { id, value };
  });
  if (!replaced) next.push({ id, value });
  return next;
}

function getParamValue(params: ModelParameterValue[], id: string): string | undefined {
  return params.find((param) => param.id === id)?.value;
}

function encodeManifestModelId(selectionModelId: string, context?: string): string {
  const encoded = context ? `${selectionModelId}@${context}` : selectionModelId;
  return `${CURSOR_PROVIDER_PREFIX}${encoded}`;
}

function getContextValues(item: ModelListItem): string[] {
  return getParameter(item, 'context')?.values.map((value) => value.value) ?? [];
}

function getAmbiguousAliases(items: ModelListItem[]): Set<string> {
  const aliasOwners = new Map<string, Set<string>>();
  for (const item of items) {
    for (const rawAlias of item.aliases ?? []) {
      const alias = rawAlias.trim();
      if (!alias || alias === item.id) continue;
      const owners = aliasOwners.get(alias) ?? new Set<string>();
      owners.add(item.id);
      aliasOwners.set(alias, owners);
    }
  }
  return new Set(
    [...aliasOwners.entries()].filter(([, owners]) => owners.size > 1).map(([alias]) => alias),
  );
}

function getModelIds(
  item: ModelListItem,
  reservedBaseModelIds: Set<string>,
  ambiguousAliases: Set<string>,
): string[] {
  const ids = [item.id];
  for (const rawAlias of item.aliases ?? []) {
    const alias = rawAlias.trim();
    if (
      !alias ||
      alias === item.id ||
      ids.includes(alias) ||
      reservedBaseModelIds.has(alias) ||
      ambiguousAliases.has(alias)
    ) {
      continue;
    }
    ids.push(alias);
  }
  return ids;
}

function toMetadata(
  item: ModelListItem,
  manifestModelId: string,
  selectionModelId: string,
  defaultParams: ModelParameterValue[],
  context: string | undefined,
): CursorModelMetadata {
  const thinkingLevelMap = getThinkingLevelMap(item);
  const fastValue = getParamValue(defaultParams, 'fast')?.toLowerCase();
  return {
    manifestModelId,
    baseModelId: item.id,
    selectionModelId,
    displayName: item.displayName || item.id,
    defaultParams: cloneParams(defaultParams),
    ...(context ? { context } : {}),
    contextWindow: (context ? parseContextWindow(context) : undefined) ?? FALLBACK_CONTEXT_WINDOW,
    supportsFast: getParameter(item, 'fast') !== undefined,
    defaultFast: fastValue === 'true',
    supportsReasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    parameterIds: {
      context: getParameter(item, 'context') !== undefined,
      reasoning: getParameter(item, 'reasoning') !== undefined,
      effort: getParameter(item, 'effort') !== undefined,
      thinking: getParameter(item, 'thinking') !== undefined,
      fast: getParameter(item, 'fast') !== undefined,
    },
  };
}

function registerModelItems(items: ModelListItem[]): void {
  metadataByManifestModelId.clear();
  const usedManifestIds = new Set<string>();
  const reservedBaseModelIds = new Set(items.map((item) => item.id));
  const ambiguousAliases = getAmbiguousAliases(items);

  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const defaultParams = getDefaultParams(item);
    const contextValues = getContextValues(item);
    const contexts = contextValues.length > 0 ? contextValues : [undefined];

    for (const selectionModelId of getModelIds(item, reservedBaseModelIds, ambiguousAliases)) {
      for (const context of contexts) {
        const params = context ? replaceParam(defaultParams, 'context', context) : defaultParams;
        const manifestModelId = encodeManifestModelId(selectionModelId, context);
        if (usedManifestIds.has(manifestModelId)) continue;
        usedManifestIds.add(manifestModelId);
        metadataByManifestModelId.set(
          manifestModelId,
          toMetadata(item, manifestModelId, selectionModelId, params, context),
        );
      }
    }
  }
}

export function getCursorModelMetadata(manifestModelId: string): CursorModelMetadata | undefined {
  const normalized = manifestModelId.startsWith(CURSOR_PROVIDER_PREFIX)
    ? manifestModelId
    : `${CURSOR_PROVIDER_PREFIX}${manifestModelId}`;
  return metadataByManifestModelId.get(normalized);
}

export function registerCursorModelCatalog(items: ModelListItem[]): void {
  registerModelItems(items);
}

export function listCursorModelMetadata(): CursorModelMetadata[] {
  return [...metadataByManifestModelId.values()].map((metadata) => ({
    ...metadata,
    defaultParams: cloneParams(metadata.defaultParams),
    ...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
    parameterIds: { ...metadata.parameterIds },
  }));
}

registerCursorModelCatalog(FALLBACK_MODEL_ITEMS);

export const __testUtils = {
  encodeManifestModelId,
  parseContextWindow,
  getThinkingLevelMap,
  registerModelItems,
};
