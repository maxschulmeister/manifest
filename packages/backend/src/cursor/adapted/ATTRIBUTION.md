# Adapted from pi-cursor-sdk (MIT)

The following modules are adapted from [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk)
by fitchmultz, MIT License:

- `cursor-session-agent.ts`
- `cursor-session-send-policy.ts`
- `cursor-provider-live-run-drain.ts` (Phase 2: helpers + registry only; full drain in Phase 3)
- `cursor-provider-errors.ts`
- `cursor-setting-sources.ts` (Manifest forces `settingSources: []`; no env override)

Manifest-specific changes: removed pi-tool-bridge/MCP wiring, pi session hooks, and
pi-ai `Context` types; session scope keys are supplied by Manifest (`agentId:apiKeyHash:conversationId`).
