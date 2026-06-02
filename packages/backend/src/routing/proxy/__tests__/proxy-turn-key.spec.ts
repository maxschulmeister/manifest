import { buildSyntheticTurnKey } from '../proxy-turn-key';

describe('buildSyntheticTurnKey', () => {
  it('builds a stable key from custom-tier alias, session, user turn, and latest user content', () => {
    const body = {
      model: 'fast',
      tools: [{ type: 'function', function: { name: 'search' } }],
      messages: [
        { role: 'system', content: 'instructions' },
        { role: 'user', content: 'find cats' },
        { role: 'assistant', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'cat results' },
      ],
    };

    expect(buildSyntheticTurnKey(body, 'session-1', 'fast')).toBe(
      buildSyntheticTurnKey({ ...body, stream: true }, 'session-1', 'fast'),
    );
  });

  it('changes the key for a different user turn in the same session', () => {
    const first = buildSyntheticTurnKey(
      {
        model: 'fast',
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'same text' }],
      },
      'session-1',
      'fast',
    );
    const second = buildSyntheticTurnKey(
      {
        model: 'fast',
        tool_choice: 'auto',
        messages: [
          { role: 'user', content: 'same text' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'same text' },
        ],
      },
      'session-1',
      'fast',
    );

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('returns undefined when the request is not a tool-capable custom-tier chat turn', () => {
    expect(buildSyntheticTurnKey({ messages: [] }, 'session-1', 'fast')).toBeUndefined();
    expect(
      buildSyntheticTurnKey(
        { model: 'fast', messages: [{ role: 'user', content: 'hi' }] },
        'session-1',
        'fast',
      ),
    ).toBeUndefined();
    expect(
      buildSyntheticTurnKey(
        { model: 'fast', tools: [], messages: [{ role: 'assistant', content: 'hi' }] },
        'session-1',
        'fast',
      ),
    ).toBeUndefined();
    expect(
      buildSyntheticTurnKey(
        {
          model: 'fast',
          tool_choice: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
        },
        'default',
        'fast',
      ),
    ).toBeUndefined();
  });

  it('supports non-string user content', () => {
    const key = buildSyntheticTurnKey(
      {
        model: 'fast',
        tool_choice: 'auto',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look up cats' }] }],
      },
      'session-1',
      'fast',
    );

    expect(key).toMatch(/^turn:/);
  });
});
