import type { ModelParameterValue, ModelSelection } from '@cursor/sdk';

const CURSOR_VENDOR_PREFIX = 'cursor/';

export interface ParsedCursorModel {
  selection: ModelSelection;
  manifestModelId: string;
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
