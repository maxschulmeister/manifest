#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cursor } from '@cursor/sdk';

const FALLBACK_MODELS_PATH = resolve(
  process.cwd(),
  'packages/backend/src/cursor/cursor-fallback-models.generated.ts',
);

function printHelp() {
  console.log(`Refresh reviewable Cursor model fallback snapshots.

Usage:
  npm run refresh:cursor-snapshots -- --write
  node scripts/refresh-cursor-model-snapshots.mjs [--write] [--api-key <key>]

Options:
  --write           Write ${FALLBACK_MODELS_PATH}
  --api-key <key>   Cursor API key (prefer CURSOR_API_KEY env var)
  -h, --help        Show this help

Notes:
  - Prints model IDs/counts only; never prints API keys.
  - Source of truth: Cursor.models.list({ apiKey }).`);
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  const write = argv.includes('--write');
  let apiKey = process.env.CURSOR_API_KEY?.trim() ?? '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api-key') {
      apiKey = argv[i + 1]?.trim() ?? '';
    }
  }
  if (!apiKey) {
    console.error('missing Cursor API key; set CURSOR_API_KEY or pass --api-key');
    process.exit(1);
  }
  return { write, apiKey };
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sanitizeModelItem(item) {
  return stripUndefined({
    id: item.id,
    displayName: item.displayName,
    description: item.description,
    aliases: Array.isArray(item.aliases) ? [...item.aliases] : undefined,
    parameters: Array.isArray(item.parameters)
      ? item.parameters.map((parameter) =>
          stripUndefined({
            id: parameter.id,
            displayName: parameter.displayName,
            values: Array.isArray(parameter.values)
              ? parameter.values.map((value) =>
                  stripUndefined({ value: value.value, displayName: value.displayName }),
                )
              : [],
          }),
        )
      : undefined,
    variants: Array.isArray(item.variants)
      ? item.variants.map((variant) =>
          stripUndefined({
            params: Array.isArray(variant.params)
              ? variant.params.map((param) => ({ id: param.id, value: param.value }))
              : [],
            displayName: variant.displayName,
            description: variant.description,
            isDefault: variant.isDefault,
          }),
        )
      : undefined,
  });
}

function stableStringify(value) {
  return JSON.stringify(value, null, '\t').replace(/"([^"\\]+)":/g, '$1:');
}

function formatFallbackModels(models) {
  return `import type { ModelListItem } from '@cursor/sdk';\n\n// Generated/maintained fallback Cursor catalog snapshot.\n// Refresh with: npm run refresh:cursor-snapshots -- --write\n// Do not add secrets; this file stores public model metadata only.\nexport const FALLBACK_MODEL_ITEMS = ${stableStringify(models)} satisfies ModelListItem[];\n`;
}

const { write, apiKey } = parseArgs(process.argv.slice(2));

let rawModels;
try {
  rawModels = await Cursor.models.list({ apiKey });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Cursor.models.list() failed: ${message.replaceAll(apiKey, '[redacted]')}`);
  process.exit(1);
}

if (!Array.isArray(rawModels) || rawModels.length === 0) {
  console.error('Cursor.models.list() returned no models');
  process.exit(1);
}

const models = rawModels.map(sanitizeModelItem).sort((a, b) => a.id.localeCompare(b.id));
console.log(`Fetched ${models.length} Cursor models.`);
console.log(
  `First models: ${models
    .slice(0, 8)
    .map((model) => model.id)
    .join(', ')}${models.length > 8 ? ', ...' : ''}`,
);

if (write) {
  writeFileSync(FALLBACK_MODELS_PATH, formatFallbackModels(models));
  console.log(`Wrote ${FALLBACK_MODELS_PATH}`);
} else {
  console.log('Dry run only. Re-run with --write to update snapshots.');
}
