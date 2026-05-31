/**
 * Adapted from pi-cursor-sdk cursor-tool-manifest.ts (MIT). See adapted/ATTRIBUTION.md.
 */
import type { ManifestToolBridgeSnapshot } from './adapted/manifest-tool-bridge-types';

export const CURSOR_HOST_TOOL_MANIFEST_SUMMARY =
  'read, shell, grep, glob, ls, edit, write, delete, readLints, updateTodos, createPlan, task, generateImage, mcp, semSearch, recordScreen, and web search/fetch when exposed';

export function buildCursorToolManifestText(
  options: {
    bridgeSnapshot?: ManifestToolBridgeSnapshot;
    bridgeEnabled?: boolean;
  } = {},
): string {
  const bridgeEnabled = options.bridgeEnabled ?? true;
  const lines = [
    'Callable tool surfaces this run:',
    `- Cursor SDK host tools (callable; not listed in MCP listTools): ${CURSOR_HOST_TOOL_MANIFEST_SUMMARY}.`,
    '- Configured Cursor MCP servers: discovered at runtime via MCP listTools (depends on Cursor settings).',
  ];
  const bridgeTools = options.bridgeSnapshot?.tools ?? [];
  if (!bridgeEnabled) {
    lines.push('- Manifest bridge: disabled.');
  } else if (bridgeTools.length === 0) {
    lines.push('- Manifest bridge: no manifest__* tools exposed this run.');
  } else {
    const names = [...bridgeTools.map((tool) => tool.mcpToolName)].sort().join(', ');
    lines.push(
      `- Manifest bridge (call manifest__* MCP names; agent uses real tool names): ${names}.`,
    );
  }
  lines.push('- Not callable: replay IDs and transcript labels.');
  return lines.join('\n');
}
