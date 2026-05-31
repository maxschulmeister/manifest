import {
  DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
  cursorLiveRuns,
  disposeManifestCursorLiveRun,
  getCursorNativeReplayIdleDisposeMs,
  getManifestCursorLiveRun,
  hasTrailingUserMessagesAfterToolResults,
  registerManifestCursorLiveRun,
  releaseAllPendingCursorLiveRunsForTests,
  resetCursorNativeReplayIdleDisposeMs,
  setCursorNativeReplayIdleDisposeMs,
} from './cursor-provider-live-run-drain';

describe('cursor-provider-live-run-drain', () => {
  afterEach(async () => {
    await releaseAllPendingCursorLiveRunsForTests();
    resetCursorNativeReplayIdleDisposeMs();
  });

  it('detects user messages after tool results', () => {
    expect(
      hasTrailingUserMessagesAfterToolResults([
        { role: 'user', content: 'run' },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', tool_call_id: 'c1', content: 'done' },
        { role: 'user', content: 'next' },
      ]),
    ).toBe(true);
    expect(hasTrailingUserMessagesAfterToolResults([{ role: 'user', content: 'only user' }])).toBe(
      false,
    );
  });

  it('tracks live runs per scope', () => {
    registerManifestCursorLiveRun('scope-1', 'run-a');
    expect(cursorLiveRuns.count()).toBe(1);
    expect(getManifestCursorLiveRun('scope-1')?.id).toBe('run-a');
    expect(cursorLiveRuns.getForScope('scope-1')?.id).toBe('run-a');
    disposeManifestCursorLiveRun('scope-1');
    expect(cursorLiveRuns.count()).toBe(0);
    expect(getManifestCursorLiveRun('scope-1')).toBeUndefined();
    disposeManifestCursorLiveRun('missing-scope');
  });

  it('returns false when latest user is not preceded by tool results', () => {
    expect(
      hasTrailingUserMessagesAfterToolResults([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ]),
    ).toBe(false);
  });

  it('configures native replay idle dispose ms', () => {
    setCursorNativeReplayIdleDisposeMs(12_000);
    expect(getCursorNativeReplayIdleDisposeMs()).toBe(12_000);
    resetCursorNativeReplayIdleDisposeMs();
    expect(getCursorNativeReplayIdleDisposeMs()).toBe(DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS);
  });
});
