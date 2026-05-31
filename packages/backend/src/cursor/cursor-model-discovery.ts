import type { ModelListItem, ModelParameterDefinition } from '@cursor/sdk';
import { Cursor } from '@cursor/sdk';
import { DiscoveredModel } from '../model-discovery/model-fetcher';
import { FALLBACK_MODEL_ITEMS } from './cursor-fallback-models.generated';

const CURSOR_PROVIDER_ID = 'cursor';
const FALLBACK_CONTEXT_WINDOW = 128_000;
const ZERO_PRICING = { input: 0, output: 0 };

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
  return item.parameters?.find((parameter) => parameter.id === id);
}

function parseContextWindow(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(amount)) return undefined;
  return Math.round(amount * (unit === 'm' ? 1_000_000 : 1_000));
}

function encodeModelId(selectionModelId: string, context?: string): string {
  const encoded = context ? `${selectionModelId}@${context}` : selectionModelId;
  return `${CURSOR_PROVIDER_ID}/${encoded}`;
}

function getModelName(item: ModelListItem, context?: string, alias?: string): string {
  const displayName = item.displayName || item.id;
  const baseName = alias ? `${displayName} (${alias})` : displayName;
  return context ? `${baseName} @ ${context}` : baseName;
}

function supportsReasoning(item: ModelListItem): boolean {
  return (
    getParameter(item, 'reasoning') !== undefined ||
    getParameter(item, 'effort') !== undefined ||
    getParameter(item, 'thinking') !== undefined
  );
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

function expandModelListItems(items: ModelListItem[]): DiscoveredModel[] {
  const usedIds = new Set<string>();
  const reservedBaseModelIds = new Set(items.map((item) => item.id));
  const ambiguousAliases = getAmbiguousAliases(items);
  const models: DiscoveredModel[] = [];

  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of sorted) {
    const contextValues = getContextValues(item);
    const contexts = contextValues.length > 0 ? contextValues : [undefined];
    const reasoning = supportsReasoning(item);

    for (const selectionModelId of getModelIds(item, reservedBaseModelIds, ambiguousAliases)) {
      const alias = selectionModelId === item.id ? undefined : selectionModelId;
      for (const context of contexts) {
        const manifestId = encodeModelId(selectionModelId, context);
        if (usedIds.has(manifestId)) continue;
        usedIds.add(manifestId);

        const contextWindow =
          (context ? parseContextWindow(context) : undefined) ?? FALLBACK_CONTEXT_WINDOW;

        models.push({
          id: manifestId,
          displayName: getModelName(item, context, alias),
          provider: CURSOR_PROVIDER_ID,
          contextWindow,
          inputPricePerToken: ZERO_PRICING.input,
          outputPricePerToken: ZERO_PRICING.output,
          capabilityReasoning: reasoning,
          capabilityCode: true,
          inputModalities: ['text', 'image'],
          qualityScore: 3,
        });
      }
    }
  }

  return models;
}

export function buildCursorFallbackModels(): DiscoveredModel[] {
  return expandModelListItems(FALLBACK_MODEL_ITEMS);
}

export async function discoverCursorModels(apiKey: string): Promise<DiscoveredModel[]> {
  const trimmed = apiKey.trim();
  if (!trimmed) return [];

  try {
    const items = await Cursor.models.list({ apiKey: trimmed });
    if (!items.length) return [];
    return expandModelListItems(items);
  } catch {
    return [];
  }
}

export const __testUtils = {
  expandModelListItems,
  encodeModelId,
  parseContextWindow,
};
