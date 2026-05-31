/**
 * Generic JSON-schema validation for bridged MCP tool arguments (from pi's OpenAI tool definitions).
 */
import type { ManifestMcpInputSchema } from './manifest-tool-bridge-types';
import { isRecord } from './manifest-tool-bridge-mcp';

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}

export function formatBridgedToolSchemaHint(schema: ManifestMcpInputSchema): string {
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};
  if (required.length === 0 && Object.keys(properties).length === 0) {
    return 'Use the exact JSON property names from the bridged tool schema.';
  }

  const lines = ['Bridged parameter schema (exact property names required):'];
  if (required.length > 0) {
    lines.push(`Required: ${required.join(', ')}`);
  }
  for (const key of required) {
    const prop = properties[key];
    if (isRecord(prop) && typeof prop.description === 'string' && prop.description.trim()) {
      lines.push(`- ${key}: ${prop.description.trim()}`);
    }
  }
  const optional = Object.keys(properties).filter((key) => !required.includes(key));
  if (optional.length > 0) {
    lines.push(`Optional: ${optional.join(', ')}`);
  }
  return lines.join('\n');
}

export function validateArgsAgainstBridgedSchema(
  schema: ManifestMcpInputSchema,
  args: Record<string, unknown>,
): string | undefined {
  const required = schema.required ?? [];
  const missing = required.filter((key) => isEmptyValue(args[key]));
  if (missing.length > 0) {
    return [
      'Bridged tool arguments failed schema validation.',
      `Missing or empty required properties: ${missing.join(', ')}`,
      `Expected schema properties: ${Object.keys(schema.properties ?? {}).join(', ') || '(none)'}`,
      `Received: ${JSON.stringify(args)}`,
    ].join(' ');
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set([...Object.keys(schema.properties ?? {}), ...required]);
    const unknown = Object.keys(args).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      return [
        'Bridged tool arguments failed schema validation.',
        `Unknown properties (not in schema): ${unknown.join(', ')}`,
        `Allowed: ${[...allowed].join(', ') || '(none)'}`,
        `Received: ${JSON.stringify(args)}`,
      ].join(' ');
    }
  }

  return undefined;
}
