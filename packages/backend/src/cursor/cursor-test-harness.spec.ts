import { disposeCursorTestState, isCursorLiveTestsEnabled } from './cursor-test-harness';

describe('cursor-test-harness', () => {
  afterEach(async () => {
    await disposeCursorTestState();
  });

  it('enables live tests only when RUN_CURSOR_LIVE_TESTS is explicitly set', () => {
    expect(isCursorLiveTestsEnabled({})).toBe(false);
    expect(isCursorLiveTestsEnabled({ CURSOR_API_KEY: 'sk-test' })).toBe(false);
    expect(isCursorLiveTestsEnabled({ RUN_CURSOR_LIVE_TESTS: '0' })).toBe(false);
    expect(isCursorLiveTestsEnabled({ RUN_CURSOR_LIVE_TESTS: '1' })).toBe(true);
    expect(isCursorLiveTestsEnabled({ RUN_CURSOR_LIVE_TESTS: 'true' })).toBe(true);
    expect(isCursorLiveTestsEnabled({ RUN_CURSOR_LIVE_TESTS: 'yes' })).toBe(true);
  });
});
