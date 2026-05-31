# Adapted from pi-cursor-sdk (MIT)

The following modules are adapted from [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk)
by fitchmultz, MIT License:

- `cursor-session-agent.ts`
- `cursor-session-send-policy.ts`
- `cursor-provider-live-run-drain.ts` (helpers; full resume in `manifest-cursor-live-run.ts`)
- `manifest-tool-bridge-*.ts`, `manifest-bridge-contract.ts`, `cursor-mcp-timeout-override.ts` (from pi-cursor-sdk bridge modules)
- `cursor-provider-errors.ts`
- `cursor-setting-sources.ts` (Manifest forces `settingSources: []`; no env override)

Manifest-specific changes: `manifest__*` tool bridge (loopback MCP), live-run resume,
session scope keys supplied by Manifest (`agentId:apiKeyHash:conversationId`); no pi-ai
`Context` types or pi-side tool execution on the Manifest host.
