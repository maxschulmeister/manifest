import {
  formatBridgedToolSchemaHint,
  validateArgsAgainstBridgedSchema,
} from './manifest-tool-bridge-schema';

describe('manifest-tool-bridge-schema', () => {
  it('formats required properties from any bridged schema', () => {
    const hint = formatBridgedToolSchemaHint({
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results' },
      },
    });
    expect(hint).toContain('Required: query');
    expect(hint).toContain('query: Search query');
    expect(hint).toContain('Optional: limit');
  });

  it('rejects args missing required schema properties', () => {
    const error = validateArgsAgainstBridgedSchema(
      {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
      { search_term: 'hackernews' },
    );
    expect(error).toContain('Missing or empty required properties: query');
    expect(error).toContain('search_term');
  });

  it('rejects unknown properties when additionalProperties is false', () => {
    const error = validateArgsAgainstBridgedSchema(
      {
        type: 'object',
        required: ['command'],
        additionalProperties: false,
        properties: { command: { type: 'string' } },
      },
      { command: 'ls', explanation: 'list files' },
    );
    expect(error).toContain('Unknown properties');
    expect(error).toContain('explanation');
  });
});
