import { hasTrailingUserMessagesAfterToolResults } from './cursor-provider-live-run-drain';

describe('cursor-provider-live-run-drain', () => {
  it('detects user messages after tool results', () => {
    expect(
      hasTrailingUserMessagesAfterToolResults([
        { role: 'user', content: 'run' },
        { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
        { role: 'user', content: 'continue' },
      ]),
    ).toBe(true);
  });

  it('returns false when there is no trailing user after tools', () => {
    expect(hasTrailingUserMessagesAfterToolResults([{ role: 'user', content: 'only user' }])).toBe(
      false,
    );
    expect(
      hasTrailingUserMessagesAfterToolResults([
        { role: 'user', content: 'run' },
        { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
      ]),
    ).toBe(false);
  });
});
