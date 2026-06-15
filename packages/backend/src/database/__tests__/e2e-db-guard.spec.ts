import { resolveE2eDatabaseConfig } from '../e2e-db-guard';

describe('resolveE2eDatabaseConfig', () => {
  it('throws a clear error when DATABASE_URL is not set', () => {
    expect(() => resolveE2eDatabaseConfig({})).toThrow(/DATABASE_URL must be set/);
  });

  it('refuses to drop the schema unless explicitly confirmed, naming the target DB', () => {
    expect(() =>
      resolveE2eDatabaseConfig({
        DATABASE_URL: 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
      }),
    ).toThrow(/mydatabase/);
  });

  it('returns the url with dropSchema enabled only when both flags are set', () => {
    const config = resolveE2eDatabaseConfig({
      DATABASE_URL: 'postgresql://myuser:mypassword@localhost:5432/manifest_e2e_test',
      ALLOW_E2E_DROP_SCHEMA: '1',
    });
    expect(config).toEqual({
      url: 'postgresql://myuser:mypassword@localhost:5432/manifest_e2e_test',
      dropSchema: true,
    });
  });

  it('shows the operator how to confirm a wipe in the refuse error', () => {
    expect(() =>
      resolveE2eDatabaseConfig({
        DATABASE_URL: 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
      }),
    ).toThrow(/ALLOW_E2E_DROP_SCHEMA/);
  });

  it('does not crash when DATABASE_URL is unparseable (falls back to a label)', () => {
    expect(() =>
      resolveE2eDatabaseConfig({
        DATABASE_URL: 'not a real url',
      }),
    ).toThrow(/unparseable DATABASE_URL/);
  });
});
