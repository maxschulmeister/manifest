import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TEST_API_KEY } from './helpers';

/**
 * End-to-end coverage for operator-added models on integrated providers.
 *
 * Why e2e and not a unit-wiring test: ManualModelService lives in
 * RoutingCoreModule but is injected into ProviderController in RoutingModule —
 * a cross-module dependency. Unit tests that construct the controller manually
 * bypass Nest's DI container, so a missing `exports` entry is invisible to
 * them (the bug that shipped). createTestApp() compiles the REAL application,
 * so a missing export fails here at boot — exactly where the bug lives.
 *
 * Boundary-wise: only the OpenRouter pricing fetch is stubbed (by the test
 * helper). Every service, the module graph, the DB, and the HTTP layer are real.
 */
describe('Manual models on integrated providers (e2e)', () => {
  let app: INestApplication;
  const agentName = 'test-agent';
  const headers = { 'x-api-key': TEST_API_KEY };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const manualModelId = 'gpt-manual-test-model';

  it('connects the provider', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/providers`)
      .set(headers)
      .send({ provider: 'openai', apiKey: 'sk-test-manual-models' })
      .expect(201);
  });

  it('GET manual-models is empty before any are added', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('POST manual-models adds the model', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .send({ model_name: manualModelId })
      .expect(201);

    expect(res.body).toEqual({ model_name: manualModelId });
  });

  it('GET manual-models lists the added model', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .expect(200);

    expect(res.body).toEqual([{ model_name: manualModelId }]);
  });

  it('GET available-models exposes the manual model and flags it manual', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    const manual = res.body.find((m: { model_name: string }) => m.model_name === manualModelId);
    expect(manual).toBeDefined();
    expect(manual.provider).toBe('openai');
    expect(manual.auth_type).toBe('api_key');
    expect(manual.manual).toBe(true);
  });

  it('surfaces user-entered prices on the manual model (round-trip through discovery)', async () => {
    // Add a model WITH prices. This is the path that broke: prices were
    // discarded during the manual-model merge, so the UI showed "–".
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .send({
        model_name: 'priced-manual',
        input_price_per_million_tokens: 3,
        output_price_per_million_tokens: 15,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    const priced = res.body.find(
      (m: { model_name: string }) => m.model_name === 'priced-manual',
    );
    expect(priced).toBeDefined();
    // Per-token = per-million / 1_000_000.
    expect(priced.input_price_per_token).toBeCloseTo(3 / 1_000_000, 12);
    expect(priced.output_price_per_token).toBeCloseTo(15 / 1_000_000, 12);

    // Cleanup so the count/no-longer-listed tests below stay deterministic.
    await request(app.getHttpServer())
      .delete(
        `/api/v1/routing/${agentName}/providers/openai/manual-models/priced-manual?authType=api_key`,
      )
      .set(headers)
      .expect(200);
  });

  it('POST manual-models rejects shadowing a model the provider already serves', async () => {
    // gpt-4o is in the seeded OpenRouter pricing fixture, so OpenAI discovery
    // surfaces it. Adding it manually must be rejected.
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .send({ model_name: 'gpt-4o' })
      .expect(400);
  });

  it('POST manual-models is idempotent for an already-manual model', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .send({ model_name: manualModelId })
      .expect(201);

    expect(res.body).toEqual({ model_name: manualModelId });

    // Still exactly one manual entry.
    const list = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .expect(200);
    expect(list.body).toEqual([{ model_name: manualModelId }]);
  });

  it('DELETE manual-models removes the model', async () => {
    await request(app.getHttpServer())
      .delete(
        `/api/v1/routing/${agentName}/providers/openai/manual-models/${manualModelId}?authType=api_key`,
      )
      .set(headers)
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/providers/openai/manual-models?authType=api_key`)
      .set(headers)
      .expect(200);
    expect(list.body).toEqual([]);
  });

  it('GET available-models no longer lists the removed manual model', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    expect(
      res.body.find((m: { model_name: string }) => m.model_name === manualModelId),
    ).toBeUndefined();
  });

  it('POST manual-models returns 404 for an unconnected provider', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/providers/anthropic/manual-models?authType=api_key`)
      .set(headers)
      .send({ model_name: 'never-connected' })
      .expect(404);
  });
});
