#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-$((38000 + RANDOM % 10000))}"
FAKE_PROVIDER_PORT="${FAKE_PROVIDER_PORT:-$((48000 + RANDOM % 10000))}"
DB_NAME="${DB_NAME:-manifest_curl_grouping_$(openssl rand -hex 4)}"
DB_URL="postgresql://myuser:mypassword@localhost:5432/${DB_NAME}"
FAKE_PROVIDER_LOG="${TMPDIR:-/tmp}/manifest-fake-provider-${DB_NAME}.log"
BACKEND_LOG="${TMPDIR:-/tmp}/manifest-backend-${DB_NAME}.log"
TMP_WORK="$(mktemp -d "${TMPDIR:-/tmp}/manifest-curl-grouping.XXXXXX")"

BACKEND_PID=""
FAKE_PROVIDER_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$FAKE_PROVIDER_PID" ]]; then
    kill "$FAKE_PROVIDER_PID" 2>/dev/null || true
    wait "$FAKE_PROVIDER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_WORK"
}
trap cleanup EXIT

psql_db() {
  docker exec -i postgres_db psql -U myuser -d "$DB_NAME" "$@"
}

psql_scalar() {
  psql_db -t -A -c "$1" | tr -d '[:space:]'
}

wait_for_url() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "Timed out waiting for ${name}: ${url}" >&2
  return 1
}

start_postgres() {
  docker start postgres_db >/dev/null 2>&1 || \
    docker run -d --name postgres_db \
      -e POSTGRES_USER=myuser \
      -e POSTGRES_PASSWORD=mypassword \
      -e POSTGRES_DB=mydatabase \
      -p 5432:5432 \
      postgres:16 >/dev/null

  for _ in $(seq 1 60); do
    if docker exec postgres_db pg_isready -U myuser >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "Postgres did not become ready" >&2
  exit 1
}

create_database() {
  docker exec postgres_db psql -U myuser -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || \
    docker exec postgres_db psql -U myuser -d postgres -c "CREATE DATABASE ${DB_NAME};" >/dev/null
}

start_fake_provider() {
  PORT="$FAKE_PROVIDER_PORT" node >"$FAKE_PROVIDER_LOG" 2>&1 <<'JS' &
const http = require('http');
const port = Number(process.env.PORT);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const toolNames = ['read', 'bash', 'write'];

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', method: req.method, url: req.url }));
    return;
  }

  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolResultCount = messages.filter((message) => message && message.role === 'tool').length;
  const usage = {
    prompt_tokens: 100 + toolResultCount * 37,
    completion_tokens: 11 + toolResultCount * 13,
  };

  let message;
  if (toolResultCount < toolNames.length) {
    const name = toolNames[toolResultCount];
    const args =
      name === 'read'
        ? { path: 'packages/backend/.env.example' }
        : name === 'bash'
          ? { command: 'ls -1 packages/backend' }
          : { path: 'packages/backend/CURL_REPRO_TMP.txt', content: 'Test' };
    message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `call_${toolResultCount + 1}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    };
  } else {
    message = { role: 'assistant', content: 'Done.' };
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: `chatcmpl-${Date.now()}-${toolResultCount}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'mock-model',
    choices: [{ index: 0, message, finish_reason: toolResultCount < toolNames.length ? 'tool_calls' : 'stop' }],
    usage,
  }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake provider listening on ${port}`);
});
JS
  FAKE_PROVIDER_PID=$!
  wait_for_url "http://127.0.0.1:${FAKE_PROVIDER_PORT}/api/tags" "fake provider"
}

start_backend() {
  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    (cd "$ROOT_DIR" && npm run build --workspace=packages/backend)
  fi

  (cd "$ROOT_DIR" && \
    PORT="$BACKEND_PORT" \
    BIND_ADDRESS=127.0.0.1 \
    NODE_ENV=development \
    MANIFEST_MODE=cloud \
    BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    MANIFEST_ENCRYPTION_KEY=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 \
    DATABASE_URL="$DB_URL" \
    SEED_DATA=true \
    OLLAMA_HOST="http://127.0.0.1:${FAKE_PROVIDER_PORT}" \
    node packages/backend/dist/main.js >"$BACKEND_LOG" 2>&1) &
  BACKEND_PID=$!
  wait_for_url "http://127.0.0.1:${BACKEND_PORT}/api/v1/health" "backend"
  wait_for_seed_db
}

wait_for_seed_db() {
  for _ in $(seq 1 120); do
    if docker exec postgres_db psql -U myuser -d "$DB_NAME" -t -A -c "SELECT COUNT(*) FROM tenants WHERE id = 'seed-tenant-001';" 2>/dev/null | tr -d '[:space:]' | grep -q '^1$'; then
      return 0
    fi
    if [[ -n "$BACKEND_PID" ]] && ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      echo "Backend exited before seed DB became ready. Log: $BACKEND_LOG" >&2
      tail -80 "$BACKEND_LOG" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  echo "Timed out waiting for seeded database. Log: $BACKEND_LOG" >&2
  tail -80 "$BACKEND_LOG" >&2 || true
  exit 1
}

configure_routing() {
  psql_db -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  seed_user text;
  route jsonb := '{"provider":"ollama","authType":"local","model":"ollama/mock-model"}'::jsonb;
BEGIN
  SELECT name INTO seed_user FROM tenants WHERE id = 'seed-tenant-001';
  IF seed_user IS NULL THEN
    RAISE EXCEPTION 'seed tenant missing';
  END IF;

  UPDATE agents
  SET complexity_routing_enabled = false,
      record_messages = true
  WHERE id = 'seed-agent-001';

  DELETE FROM agent_messages WHERE agent_id = 'seed-agent-001';
  DELETE FROM header_tiers WHERE agent_id = 'seed-agent-001';
  DELETE FROM tier_assignments WHERE agent_id = 'seed-agent-001';
  DELETE FROM user_providers WHERE agent_id = 'seed-agent-001' AND provider = 'ollama';

  INSERT INTO user_providers (
    id, user_id, agent_id, provider, api_key_encrypted, key_prefix, auth_type,
    label, priority, region, is_active, connected_at, updated_at
  ) VALUES (
    'curl-repro-ollama-provider', seed_user, 'seed-agent-001', 'ollama', NULL, NULL, 'local',
    'Default', 0, NULL, true, NOW(), NOW()
  );

  INSERT INTO tier_assignments (
    id, user_id, agent_id, tier, override_route, auto_assigned_route, fallback_routes,
    output_modality, response_mode, updated_at
  ) VALUES
    ('curl-repro-tier-default', seed_user, 'seed-agent-001', 'default', NULL, route, NULL, 'text', 'buffered', NOW()),
    ('curl-repro-tier-simple', seed_user, 'seed-agent-001', 'simple', NULL, route, NULL, 'text', 'buffered', NOW()),
    ('curl-repro-tier-standard', seed_user, 'seed-agent-001', 'standard', NULL, route, NULL, 'text', 'buffered', NOW()),
    ('curl-repro-tier-complex', seed_user, 'seed-agent-001', 'complex', NULL, route, NULL, 'text', 'buffered', NOW()),
    ('curl-repro-tier-reasoning', seed_user, 'seed-agent-001', 'reasoning', NULL, route, NULL, 'text', 'buffered', NOW());

  INSERT INTO header_tiers (
    id, tenant_id, agent_id, user_id, name, header_key, header_value, badge_color,
    sort_order, enabled, override_route, fallback_routes, output_modality, response_mode,
    created_at, updated_at
  ) VALUES (
    'curl-repro-header-fast', 'seed-tenant-001', 'seed-agent-001', seed_user,
    'fast', 'x-manifest-tier', 'fast', 'blue',
    0, true, route, NULL, 'text', 'buffered', NOW(), NOW()
  );
END $$;
SQL
}

request_body() {
  local model="$1"
  local step="$2"
  local out="$3"
  MODEL="$model" STEP="$step" node >"$out" <<'JS'
const model = process.env.MODEL;
const step = Number(process.env.STEP);
const user = { role: 'user', content: 'call 3 tools after each other, then ur done.' };
const messages = [user];
if (step >= 2) {
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"packages/backend/.env.example"}' } }] });
  messages.push({ role: 'tool', tool_call_id: 'call_1', name: 'read', content: 'read result' });
}
if (step >= 3) {
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls -1 packages/backend"}' } }] });
  messages.push({ role: 'tool', tool_call_id: 'call_2', name: 'bash', content: 'bash result' });
}
if (step >= 4) {
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'write', arguments: '{"path":"packages/backend/CURL_REPRO_TMP.txt","content":"Test"}' } }] });
  messages.push({ role: 'tool', tool_call_id: 'call_3', name: 'write', content: 'write result' });
}
const tools = [
  { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
];
process.stdout.write(JSON.stringify({ model, stream: false, messages, tools, tool_choice: 'auto' }));
JS
}

make_traceparent() {
  local seed="$1"
  node -e "const crypto = require('crypto'); const hash = crypto.createHash('sha256').update(process.argv[1]).digest('hex'); console.log('00-' + hash.slice(0, 32) + '-' + hash.slice(32, 48) + '-01');" "$seed"
}

run_scenario() {
  local scenario="$1"
  local model="$2"
  local trace_mode="${3:-stable}"
  local extra_header_name="${4:-}"
  local extra_header_value="${5:-}"
  local session="curl-repro-${scenario}-${RANDOM}"
  local stable_traceparent
  stable_traceparent="$(make_traceparent "${session}-stable")"

  printf '\n=== %s: model=%s trace=%s%s session=%s ===\n' "$scenario" "$model" "$trace_mode" "${extra_header_name:+ ${extra_header_name}=${extra_header_value}}" "$session"

  for step in 1 2 3 4; do
    local body_file="$TMP_WORK/${scenario}-${step}.json"
    local traceparent="$stable_traceparent"
    if [[ "$trace_mode" == "rotating" ]]; then
      traceparent="$(make_traceparent "${session}-${step}")"
    fi
    request_body "$model" "$step" "$body_file"
    local curl_args=(
      -fsS
      -o "$TMP_WORK/${scenario}-${step}.response.json"
      -w "%{http_code}"
      -X POST "http://127.0.0.1:${BACKEND_PORT}/v1/chat/completions"
      -H "content-type: application/json"
      -H "x-session-key: ${session}"
      -H "traceparent: ${traceparent}"
      --data-binary "@${body_file}"
    )
    if [[ -n "$extra_header_name" ]]; then
      curl_args+=( -H "${extra_header_name}: ${extra_header_value}" )
    fi
    local status
    status="$(curl "${curl_args[@]}")"
    if [[ "$status" != "200" ]]; then
      echo "curl step ${step} returned HTTP ${status}" >&2
      cat "$TMP_WORK/${scenario}-${step}.response.json" >&2 || true
      exit 1
    fi
  done

  # recordSuccess is intentionally fire-and-forget; wait briefly for DB writes/dedup updates.
  sleep 1

  local count
  count="$(psql_scalar "SELECT COUNT(*) FROM agent_messages WHERE agent_id = 'seed-agent-001' AND session_key = '${session}' AND status = 'ok';")"
  psql_db -P pager=off -c "SELECT timestamp, status, model, routing_reason, header_tier_id, session_key, session_id, trace_id, input_tokens, output_tokens FROM agent_messages WHERE agent_id = 'seed-agent-001' AND session_key = '${session}' ORDER BY timestamp;"

  if [[ "$count" != "1" ]]; then
    echo "FAIL ${scenario}: expected 1 ok message, got ${count}" >&2
    return 1
  fi
  echo "PASS ${scenario}: 1 ok message"
}

main() {
  echo "Using DB ${DB_NAME}"
  echo "Fake provider log: ${FAKE_PROVIDER_LOG}"
  echo "Backend log: ${BACKEND_LOG}"

  start_postgres
  create_database
  start_fake_provider
  start_backend
  configure_routing

  run_scenario "auto-no-header" "auto" "stable"
  run_scenario "auto-header" "auto" "rotating" "x-manifest-tier" "fast"
  run_scenario "custom-tier-model" "fast" "rotating"

  printf '\nAll curl grouping scenarios passed.\n'
}

main "$@"
