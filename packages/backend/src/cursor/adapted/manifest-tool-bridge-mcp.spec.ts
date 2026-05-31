import {
  containsKnownMcpToolName,
  convertToolContentToMcpContent,
  createMcpToolName,
  getStringField,
  isRecord,
  normalizeMcpArgs,
  normalizeMcpInputSchema,
  snapshotToolToMcpTool,
  stableNameHash,
} from './manifest-tool-bridge-mcp';

describe('manifest-tool-bridge-mcp', () => {
  it('normalizes schemas and args', () => {
    expect(normalizeMcpInputSchema({ type: 'object', properties: {} })).toEqual({
      type: 'object',
      properties: {},
    });
    expect(normalizeMcpInputSchema(null)).toEqual({ type: 'object', properties: {} });
    expect(normalizeMcpArgs({ a: 1 })).toEqual({ a: 1 });
    expect(normalizeMcpArgs('x')).toEqual({});
  });

  it('creates unique MCP tool names with hash and counter suffixes', () => {
    const used = new Set<string>();
    expect(createMcpToolName('bash', used)).toBe('manifest__bash');
    expect(createMcpToolName('bash', used)).toMatch(/^manifest__bash__/);
    const third = createMcpToolName('bash', used);
    expect(third).not.toBe('manifest__bash');
    expect(stableNameHash('x')).toHaveLength(8);
  });

  it('uses counter suffix when base and hashed names collide', () => {
    const used = new Set<string>();
    const base = createMcpToolName('bash', used);
    const hashed = `${base}__${stableNameHash('bash')}`;
    used.add(hashed);
    used.add(`${hashed}_2`);
    const name = createMcpToolName('bash', used);
    expect(name).toBe(`${hashed}_3`);
  });

  it('stops deep recursion in containsKnownMcpToolName', () => {
    const known = new Set(['manifest__bash']);
    let nested: unknown = { tool: 'manifest__bash' };
    for (let i = 0; i < 6; i += 1) nested = { args: nested };
    expect(containsKnownMcpToolName(nested, known)).toBe(false);
  });

  it('matches tool names in arrays', () => {
    const known = new Set(['manifest__bash']);
    expect(containsKnownMcpToolName([{ name: 'manifest__bash' }], known)).toBe(true);
  });

  it('detects nested MCP tool names and reads string fields', () => {
    const known = new Set(['manifest__bash']);
    expect(containsKnownMcpToolName({ tool: 'manifest__bash' }, known)).toBe(true);
    expect(containsKnownMcpToolName({ args: { name: 'manifest__bash' } }, known)).toBe(true);
    expect(isRecord({})).toBe(true);
    expect(getStringField({ name: 'x' }, ['name', 'tool'])).toBe('x');
    expect(convertToolContentToMcpContent('hello')).toEqual([{ type: 'text', text: 'hello' }]);
    expect(
      snapshotToolToMcpTool({
        agentToolName: 'bash',
        mcpToolName: 'manifest__bash',
        description: 'Shell',
        inputSchema: { type: 'object' },
      }).name,
    ).toBe('manifest__bash');
  });
});
