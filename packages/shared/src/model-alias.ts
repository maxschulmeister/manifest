import { SPECIFICITY_CATEGORIES } from './specificity';
import type { SpecificityCategory } from './specificity';
import { TIER_SLOTS } from './tiers';
import type { TierSlot } from './tiers';

export type ModelAliasClassification =
  | { kind: 'auto' }
  | { kind: 'tier'; tier: TierSlot }
  | { kind: 'specificity'; category: SpecificityCategory }
  | { kind: 'header_tier'; id: string };

const TIER_SLOT_SET = new Set<string>(TIER_SLOTS);
const SPECIFICITY_SET = new Set<string>(SPECIFICITY_CATEGORIES);

/** API-facing model id for a specificity category. */
export function specificityCategoryToAlias(category: SpecificityCategory): string {
  return category.replace(/_/g, '-');
}

/** Map a request model id to an internal specificity category id, if recognized. */
export function aliasToSpecificityCategory(alias: string): SpecificityCategory | null {
  if (SPECIFICITY_SET.has(alias)) return alias as SpecificityCategory;
  const underscored = alias.replace(/-/g, '_');
  if (SPECIFICITY_SET.has(underscored)) return underscored as SpecificityCategory;
  return null;
}

/** Static routing model ids that do not depend on an agent's custom tiers. */
export function getStaticModelAliases(): readonly string[] {
  return ['auto', ...TIER_SLOTS, ...SPECIFICITY_CATEGORIES.map(specificityCategoryToAlias)];
}

/** API-facing model id for a custom tier name. */
export function customTierNameToModelAlias(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Backwards-compatible name for callers that want the static routing aliases. */
export const getValidAliases = getStaticModelAliases;

/**
 * Classify static request model ids. Custom tier slugs are agent-specific and are
 * resolved by the backend against header_tiers.name.
 */
export function classifyModelAlias(
  input: string | null | undefined,
): Exclude<ModelAliasClassification, { kind: 'header_tier' }> | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input === 'auto') return { kind: 'auto' };
  if (TIER_SLOT_SET.has(input)) return { kind: 'tier', tier: input as TierSlot };
  const category = aliasToSpecificityCategory(input);
  if (category) return { kind: 'specificity', category };
  return null;
}
