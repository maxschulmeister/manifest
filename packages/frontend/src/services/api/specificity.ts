import { fetchJson, fetchMutate, routingPath } from './core.js';
import type {
  AuthType,
  FallbackRouteTarget,
  ModelRoute,
  RouteTarget,
  ResponseMode,
  OutputModality,
} from './routing.js';

function isModelRouteTarget(route: FallbackRouteTarget): route is ModelRoute {
  return !('kind' in route) || route.kind !== 'header_tier';
}

export interface SpecificityAssignment {
  id: string;
  agent_id: string;
  category: string;
  is_active: boolean;
  override_route: RouteTarget | null;
  auto_assigned_route: ModelRoute | null;
  fallback_routes: FallbackRouteTarget[] | null;
  output_modality?: OutputModality;
  response_mode?: ResponseMode;
  updated_at: string;
}

export function getSpecificityAssignments(agentName: string) {
  return fetchJson<SpecificityAssignment[]>(routingPath(agentName, 'specificity'));
}

export function toggleSpecificity(agentName: string, category: string, active: boolean) {
  return fetchMutate<SpecificityAssignment>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}/toggle`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    },
  );
}

export function overrideSpecificity(
  agentName: string,
  category: string,
  model: string,
  provider: string,
  authType?: AuthType,
  providerKeyLabel?: string,
) {
  const body: Record<string, unknown> = { model, provider };
  if (authType) {
    body.authType = authType;
    const route: ModelRoute = providerKeyLabel
      ? { provider, authType, model, keyLabel: providerKeyLabel }
      : { provider, authType, model };
    body.route = route;
  }
  if (providerKeyLabel) body.providerKeyLabel = providerKeyLabel;
  return fetchMutate<SpecificityAssignment>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export function overrideSpecificityWithHeaderTier(
  agentName: string,
  category: string,
  headerTierId: string,
) {
  return fetchMutate<SpecificityAssignment>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'header_tier', id: headerTierId },
        model: headerTierId,
      }),
    },
  );
}

export function resetSpecificity(agentName: string, category: string) {
  return fetchMutate(routingPath(agentName, `specificity/${encodeURIComponent(category)}`), {
    method: 'DELETE',
  });
}

export function setSpecificityResponseMode(
  agentName: string,
  category: string,
  responseMode: ResponseMode,
) {
  return fetchMutate<SpecificityAssignment>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}/response-mode`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_mode: responseMode }),
    },
  );
}

export function setSpecificityFallbacks(
  agentName: string,
  category: string,
  models: string[],
  routes?: FallbackRouteTarget[],
) {
  const body: Record<string, unknown> = { models };
  if (routes && routes.length === models.length) body.routes = routes.filter(isModelRouteTarget);
  if (routes?.some((route) => route.kind === 'header_tier')) body.targets = routes;
  return fetchMutate<FallbackRouteTarget[]>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}/fallbacks`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export function clearSpecificityFallbacks(agentName: string, category: string) {
  return fetchMutate(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}/fallbacks`),
    { method: 'DELETE' },
  );
}

export function resetAllSpecificity(agentName: string) {
  return fetchMutate(routingPath(agentName, 'specificity/reset-all'), {
    method: 'POST',
  });
}
