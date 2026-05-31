/**
 * Adapted from pi-cursor-sdk cursor-pi-tool-bridge-mcp.ts (MIT). See ATTRIBUTION.md.
 */
import { createHash } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  buildManifestBridgeMcpToolDescription,
  MANIFEST_BRIDGE_MCP_TOOL_PREFIX,
} from './manifest-bridge-contract';
import type {
  ManifestBridgeToolDefinition,
  ManifestMcpInputSchema,
} from './manifest-tool-bridge-types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeMcpInputSchema(schema: unknown): ManifestMcpInputSchema {
  if (isRecord(schema) && schema.type === 'object') return schema as ManifestMcpInputSchema;
  return { type: 'object', properties: {} };
}

export function normalizeMcpArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? { ...args } : {};
}

export function waitForProtocolFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sanitizeMcpToolNameStem(toolName: string): string {
  const stem = toolName
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return stem || 'tool';
}

export function stableNameHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function createMcpToolName(agentToolName: string, usedMcpToolNames: Set<string>): string {
  const baseName = `${MANIFEST_BRIDGE_MCP_TOOL_PREFIX}${sanitizeMcpToolNameStem(agentToolName)}`;
  if (!usedMcpToolNames.has(baseName)) {
    usedMcpToolNames.add(baseName);
    return baseName;
  }

  const hashedName = `${baseName}__${stableNameHash(agentToolName)}`;
  if (!usedMcpToolNames.has(hashedName)) {
    usedMcpToolNames.add(hashedName);
    return hashedName;
  }

  let counter = 2;
  let candidate = `${hashedName}_${counter}`;
  while (usedMcpToolNames.has(candidate)) {
    counter += 1;
    candidate = `${hashedName}_${counter}`;
  }
  usedMcpToolNames.add(candidate);
  return candidate;
}

export function snapshotToolToMcpTool(tool: ManifestBridgeToolDefinition): Tool {
  return {
    name: tool.mcpToolName,
    description: buildManifestBridgeMcpToolDescription({
      agentToolName: tool.agentToolName,
      mcpToolName: tool.mcpToolName,
      agentToolDescription: tool.description,
    }),
    inputSchema: tool.inputSchema,
    _meta: { agentToolName: tool.agentToolName },
  };
}

export function convertToolContentToMcpContent(content: string): CallToolResult['content'] {
  return [{ type: 'text', text: content }];
}

export function containsKnownMcpToolName(
  value: unknown,
  knownMcpToolNames: ReadonlySet<string>,
  depth = 0,
): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsKnownMcpToolName(entry, knownMcpToolNames, depth + 1));
  }
  if (!isRecord(value)) return false;

  for (const field of ['tool', 'toolName', 'name', 'mcpToolName', 'serverToolName']) {
    const fieldValue = value[field];
    if (typeof fieldValue === 'string' && knownMcpToolNames.has(fieldValue)) return true;
  }

  for (const nestedField of ['args', 'arguments', 'input']) {
    if (containsKnownMcpToolName(value[nestedField], knownMcpToolNames, depth + 1)) return true;
  }

  return false;
}

export function getStringField(
  record: Record<string, unknown>,
  fields: string[],
): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
