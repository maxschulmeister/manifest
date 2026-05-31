import type { AgentModeOption, ModelParameterValue, ModelSelection } from '@cursor/sdk';
import type { RequestParamDefaults } from 'manifest-shared';
import {
  getCursorModelMetadata,
  type CursorModelMetadata,
  type CursorReasoningLevel,
} from './cursor-model-metadata';

const CURSOR_VENDOR_PREFIX = 'cursor/';
export const CURSOR_ROUTE_PARAM_PREFIX = 'cursor.';

export interface ParsedCursorModel {
  selection: ModelSelection;
  manifestModelId: string;
}

export interface CursorRouteParams {
  reasoningLevel?: CursorReasoningLevel;
  fast?: boolean;
  mode?: AgentModeOption;
}

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
  return params.map((param) => ({ ...param }));
}

function setParam(params: ModelParameterValue[], id: string, value: string): void {
  const existing = params.find((param) => param.id === id);
  if (existing) {
    existing.value = value;
  } else {
    params.push({ id, value });
  }
}

function deleteParam(params: ModelParameterValue[], id: string): void {
  const index = params.findIndex((param) => param.id === id);
  if (index >= 0) params.splice(index, 1);
}

function applyReasoningLevel(
  metadata: CursorModelMetadata,
  params: ModelParameterValue[],
  level: CursorReasoningLevel,
): void {
  const mapped = metadata.thinkingLevelMap?.[level];
  if (mapped === undefined || mapped === null) return;

  if (level === 'off') {
    if (metadata.parameterIds.thinking && mapped === 'false') {
      setParam(params, 'thinking', mapped);
      deleteParam(params, 'effort');
      return;
    }
    if (metadata.parameterIds.reasoning) {
      setParam(params, 'reasoning', mapped);
    }
    return;
  }

  if (metadata.parameterIds.effort) {
    if (metadata.parameterIds.thinking) setParam(params, 'thinking', 'true');
    setParam(params, 'effort', mapped);
    return;
  }

  if (metadata.parameterIds.reasoning) {
    setParam(params, 'reasoning', mapped);
    return;
  }

  if (metadata.parameterIds.thinking) {
    setParam(params, 'thinking', mapped);
  }
}

export function parseCursorManifestModel(model: string): ParsedCursorModel {
  const bare = model.startsWith(CURSOR_VENDOR_PREFIX)
    ? model.slice(CURSOR_VENDOR_PREFIX.length)
    : model;
  const atIndex = bare.lastIndexOf('@');
  if (atIndex === -1) {
    return {
      manifestModelId: `${CURSOR_VENDOR_PREFIX}${bare}`,
      selection: { id: bare },
    };
  }
  const id = bare.slice(0, atIndex);
  const contextValue = bare.slice(atIndex + 1);
  const params: ModelParameterValue[] = [{ id: 'context', value: contextValue }];
  return {
    manifestModelId: `${CURSOR_VENDOR_PREFIX}${bare}`,
    selection: { id, params },
  };
}

export function extractCursorRouteParams(
  values: RequestParamDefaults | Record<string, unknown> | null | undefined,
): CursorRouteParams {
  const routeParams: CursorRouteParams = {};
  if (!values || typeof values !== 'object') return routeParams;

  const reasoningLevel = values[`${CURSOR_ROUTE_PARAM_PREFIX}reasoning_level`];
  if (
    reasoningLevel === 'off' ||
    reasoningLevel === 'minimal' ||
    reasoningLevel === 'low' ||
    reasoningLevel === 'medium' ||
    reasoningLevel === 'high' ||
    reasoningLevel === 'xhigh'
  ) {
    routeParams.reasoningLevel = reasoningLevel;
  }

  const fast = values[`${CURSOR_ROUTE_PARAM_PREFIX}fast`];
  if (typeof fast === 'boolean') routeParams.fast = fast;

  const mode = values[`${CURSOR_ROUTE_PARAM_PREFIX}mode`];
  if (mode === 'agent' || mode === 'plan') routeParams.mode = mode;

  return routeParams;
}

export function resolveCursorAgentMode(
  routeParams: CursorRouteParams | undefined,
): AgentModeOption {
  return routeParams?.mode ?? 'agent';
}

export function buildCursorModelSelection(
  manifestModelId: string,
  routeParams?: CursorRouteParams,
): ModelSelection {
  const parsed = parseCursorManifestModel(manifestModelId);
  const metadata = getCursorModelMetadata(parsed.manifestModelId);

  if (!metadata) {
    return parsed.selection;
  }

  const params = cloneParams(metadata.defaultParams);
  if (parsed.selection.params?.length) {
    for (const param of parsed.selection.params) {
      setParam(params, param.id, param.value);
    }
  }

  if (routeParams?.reasoningLevel) {
    applyReasoningLevel(metadata, params, routeParams.reasoningLevel);
  }

  if (metadata.supportsFast && routeParams?.fast !== undefined) {
    setParam(params, 'fast', routeParams.fast ? 'true' : 'false');
  }

  return params.length > 0
    ? { id: metadata.selectionModelId, params }
    : { id: metadata.selectionModelId };
}

export function stripCursorRouteParams<T extends Record<string, unknown>>(body: T): T {
  const next = { ...body };
  for (const key of Object.keys(next)) {
    if (key.startsWith(CURSOR_ROUTE_PARAM_PREFIX)) {
      delete next[key];
    }
  }
  return next;
}

export const __testUtils = {
  applyReasoningLevel,
};
