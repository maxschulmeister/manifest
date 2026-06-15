/**
 * Resolves the e2e test database connection and guards against the
 * "dropSchema wiped my real dev database" footgun.
 *
 * The e2e harness boots TypeORM with `dropSchema: true`, which drops EVERY
 * table in the target database on startup. The historical default
 * `postgresql://.../mydatabase` is the SAME url the dev server uses, so
 * running `npm run test:e2e` without an explicit DATABASE_URL silently
 * destroyed real dev data.
 *
 * Two independent opt-ins are required before any destructive run:
 *   1. `DATABASE_URL` — must point at a dedicated throwaway database.
 *   2. `ALLOW_E2E_DROP_SCHEMA=1` — explicit confirmation that the operator
 *      intends to wipe *that* database.
 *
 * CI sets both against an ephemeral container (see `.github/workflows/ci.yml`),
 * so CI is unaffected. Locally, a single conscious act is no longer enough
 * to destroy data — the recurrence path that wiped dev data is closed.
 *
 * Pure and unit-tested because the safety invariant must be verifiable
 * without performing a destructive e2e run.
 */
export interface E2eDbConfig {
  url: string;
  /** True only when `ALLOW_E2E_DROP_SCHEMA=1` was explicitly set. */
  dropSchema: boolean;
}

/**
 * Extract the database name from a connection url for surfacing in error
 * messages. Falls back to a redacted label when the url can't be parsed.
 */
function databaseNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.replace(/^\//, '') || '(unknown)';
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export function resolveE2eDatabaseConfig(env: NodeJS.ProcessEnv = process.env): E2eDbConfig {
  const url = env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL must be set for e2e tests. The e2e harness rebuilds the ' +
        'schema from scratch each run, which drops every table in the target ' +
        'database. Point it at a throwaway database, e.g.:\n' +
        '  docker exec postgres_db psql -U myuser -d postgres ' +
        '-c "CREATE DATABASE manifest_e2e_test;"\n' +
        '  DATABASE_URL=postgresql://myuser:mypassword@localhost:5432/manifest_e2e_test ' +
        'ALLOW_E2E_DROP_SCHEMA=1 npm run test:e2e',
    );
  }

  const confirmDrop = env['ALLOW_E2E_DROP_SCHEMA'] === '1';
  if (!confirmDrop) {
    throw new Error(
      `Refusing to run e2e against database "${databaseNameFromUrl(url)}": the ` +
        'harness drops every table in the target database on startup.\n' +
        'Double-check DATABASE_URL points at a throwaway database (NOT your ' +
        'dev data), then confirm by setting ALLOW_E2E_DROP_SCHEMA=1.',
    );
  }

  return { url, dropSchema: true };
}
