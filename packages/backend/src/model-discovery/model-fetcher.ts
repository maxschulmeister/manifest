/**
 * Types for provider-native model discovery.
 *
 * Each provider's /models API is called using a FetcherConfig that describes
 * the endpoint, auth header, and response parser. The result is a list of
 * DiscoveredModel objects cached in user_providers.cached_models.
 */

import type {
  AuthType,
  ModelCapability,
  ModelModality,
  ModelParamDefinition,
} from 'manifest-shared';

/**
 * Default context-window size assumed when a provider's API or the pricing
 * cache does not report one. Single source of truth for model discovery.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

export interface DiscoveredModel {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  inputPricePerToken: number | null;
  outputPricePerToken: number | null;
  capabilityReasoning: boolean;
  capabilityCode: boolean;
  capabilities?: readonly ModelCapability[];
  inputModalities?: readonly ModelModality[];
  outputModalities?: readonly ModelModality[];
  supportedEndpoints?: readonly string[];
  qualityScore: number;
  authType?: AuthType;
  /**
   * True for models the operator added manually because the provider's
   * `/models` endpoint omits them. Surfaced to the UI so manual models can
   * be badged and removed; ignored by routing / proxy code (manual models
   * are forwarded like any other integrated-provider model).
   */
  manual?: boolean;
  /** Source model whose modelparams.dev schema should drive this manual model's params UI. */
  paramSchemaRef?: {
    provider: string;
    authType: AuthType;
    model: string;
  } | null;
  /** Custom parameter definitions configured for an operator-added model. */
  paramSchema?: readonly ModelParamDefinition[] | null;
  /** Raw JSON request-body defaults configured for an operator-added model. */
  paramDefaults?: unknown | null;
}

export interface FetcherConfig {
  /** Base URL for the models endpoint. */
  endpoint: string | ((key: string) => string);
  /** Build the Authorization / auth header(s). */
  buildHeaders: (key: string, authType?: string) => Record<string, string>;
  /** Parse provider-specific response JSON into DiscoveredModel[]. */
  parse: (body: unknown, provider: string) => DiscoveredModel[];
}
