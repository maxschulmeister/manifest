import type { SettingSource } from '@cursor/sdk';

/** Manifest never loads Cursor-native tools/MCP from disk (`settingSources: []`). */
export const MANIFEST_CURSOR_SETTING_SOURCES: SettingSource[] = [];

export function getManifestCursorSettingSources(): SettingSource[] {
  return MANIFEST_CURSOR_SETTING_SOURCES;
}
