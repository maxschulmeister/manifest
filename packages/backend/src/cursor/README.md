# Cursor provider (backend)

Manifest routes Cursor subscription traffic through `@cursor/sdk` and surfaces Cursor models in the same discovery/fallback pipeline as other providers.

## Model catalog strategy

**Native discovery first.** When a Cursor API key is present, `Cursor.models.list({ apiKey })` is the source of truth. Discovery runs on provider connect, per-provider refresh, and `POST /api/v1/routing/:agentName/cursor/sync`.

**Checked-in fallback second.** Cursor has no OpenAI-style public `/models` HTTP catalog and no OpenRouter pricing row set. Without a key, a failed SDK call, or an empty list, Manifest serves a **reviewable snapshot** in `cursor-fallback-models.generated.ts`. That snapshot exists so:

- The Routing UI can show models before a subscription key is pasted.
- Tier assignment and param specs still work when discovery is unavailable.
- Offline/CI tests do not call the live Cursor API.

The snapshot is **public model metadata only** (ids, display names, parameters, variants). It is not a substitute for live discovery when a key works — cached agent models still come from the last successful `discoverModels` run.

## Refreshing the fallback snapshot

From the repo root (requires a Cursor API key with model-list access):

```bash
export CURSOR_API_KEY=...   # or pass --api-key
npm run refresh:cursor-snapshots              # dry run: counts + sample ids
npm run refresh:cursor-snapshots -- --write   # rewrite cursor-fallback-models.generated.ts
```

The script sorts models by `id`, strips undefined fields, and never prints secrets. Commit the generated file when Cursor ships new models or parameter shapes change.

## Metadata lookup (param mapping)

`cursor-model-metadata.ts` keeps an **immutable** catalog built from `FALLBACK_MODEL_ITEMS` at module load. A successful live `Cursor.models.list` replaces a process-wide **live overlay** used for `getCursorModelMetadata` / param specs until cleared. Clearing the overlay (`registerCursorModelCatalog([])`) restores the bundled fallback. Expansion into Manifest `cursor/...` ids is deterministic (sorted base ids, stable alias/context rules) — see `cursor-model-discovery.ts`.

## Related entry points

| Area | File |
|------|------|
| Discovery + expansion | `cursor-model-discovery.ts` |
| Proxy / SDK session | `cursor-proxy.service.ts` |
| Routing integration | `model-discovery.service.ts`, `provider-model-fetcher.service.ts` |
| Param specs | `cursor-param-spec.ts`, `cursor-param-mapper.ts` |
