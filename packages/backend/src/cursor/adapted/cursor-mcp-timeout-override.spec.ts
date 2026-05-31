import {
  __cursorMcpTimeoutTestUtils,
  cursorMcpToolTimeoutOverrideDefaults,
  installCursorMcpToolTimeoutOverride,
  isCursorSdkMcpConnectTimeoutStack,
  isCursorSdkMcpToolTimeoutStack,
  resolveCursorMcpConnectTimeoutMs,
  resolveCursorMcpToolTimeoutMs,
  resolveMcpPatchedTimeoutDelay,
  restoreCursorMcpToolTimeoutOverrideForTests,
} from './cursor-mcp-timeout-override';

describe('cursor-mcp-timeout-override', () => {
  afterEach(() => {
    restoreCursorMcpToolTimeoutOverrideForTests();
  });

  it('defaults tool timeout to 3600s and connect to 10s', () => {
    expect(resolveCursorMcpToolTimeoutMs({})).toBe(3_600_000);
    expect(resolveCursorMcpConnectTimeoutMs({})).toBe(10_000);
  });

  it('reads env overrides', () => {
    expect(
      resolveCursorMcpToolTimeoutMs({
        MANIFEST_CURSOR_MCP_TOOL_TIMEOUT_SECONDS: '120',
      }),
    ).toBe(120_000);
    expect(
      resolveCursorMcpConnectTimeoutMs({
        MANIFEST_CURSOR_MCP_CONNECT_TIMEOUT_MS: '5000',
      }),
    ).toBe(5_000);
  });

  it('installs patched setTimeout with configured delays', () => {
    const state = installCursorMcpToolTimeoutOverride({
      timeoutMs: 90_000,
      connectTimeoutMs: 8_000,
    });
    expect(state.timeoutMs).toBe(90_000);
    expect(state.connectTimeoutMs).toBe(8_000);
    expect(state.installed).toBe(true);
  });

  it('resolves patched delays from SDK MCP stack traces', () => {
    const defaultMs = cursorMcpToolTimeoutOverrideDefaults.cursorSdkDefaultTimeoutMs;
    const toolStack =
      'Error\n    at Client.callTool (node_modules/@cursor/sdk/dist/mcp.js:1:1)\n    at Protocol._setupTimeout';
    const connectStack =
      'Error\n    at Client.connect (node_modules/@cursor/sdk/dist/mcp.js:1:1)\n    at Protocol._setupTimeout';
    expect(resolveMcpPatchedTimeoutDelay(defaultMs, toolStack, 120_000, 9_000)).toBe(120_000);
    expect(resolveMcpPatchedTimeoutDelay(defaultMs, connectStack, 120_000, 9_000)).toBe(9_000);
    expect(resolveMcpPatchedTimeoutDelay(5_000, toolStack, 120_000, 9_000)).toBe(5_000);
  });

  it('throws when patched setTimeout runs without original delegate', () => {
    installCursorMcpToolTimeoutOverride();
    const saved = globalThis.setTimeout;
    restoreCursorMcpToolTimeoutOverrideForTests();
    expect(() =>
      __cursorMcpTimeoutTestUtils.patchedSetTimeoutForTests(() => undefined, 60_000),
    ).toThrow(/without original setTimeout/);
    globalThis.setTimeout = saved;
  });

  it('leaves non-matching SDK stacks at default delay', () => {
    const defaultMs = cursorMcpToolTimeoutOverrideDefaults.cursorSdkDefaultTimeoutMs;
    const stack = 'Error\n    at Protocol._setupTimeout (node_modules/@cursor/sdk/dist/mcp.js:1:1)';
    expect(resolveMcpPatchedTimeoutDelay(defaultMs, stack, 120_000, 9_000)).toBe(defaultMs);
  });

  it('classifies connect vs tool stacks', () => {
    const connectStack =
      'Error\n    at Client.connect (node_modules/@cursor/sdk/dist/mcp.js:1:1)\n    at Protocol._setupTimeout';
    const toolStack =
      'Error\n    at Client.callTool (node_modules/@cursor/sdk/dist/mcp.js:1:1)\n    at Protocol._setupTimeout';
    expect(isCursorSdkMcpConnectTimeoutStack(connectStack)).toBe(true);
    expect(isCursorSdkMcpToolTimeoutStack(toolStack)).toBe(true);
    expect(isCursorSdkMcpConnectTimeoutStack(toolStack)).toBe(false);
  });
});
