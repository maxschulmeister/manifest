import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ManualModelDto, ManualModelSettingsDto } from './manual-model.dto';

function toDto(data: Record<string, unknown>): ManualModelDto {
  return plainToInstance(ManualModelDto, data);
}

describe('ManualModelDto', () => {
  it('accepts a bare model name', async () => {
    const errors = await validate(toDto({ model_name: 'claude-secret' }));
    expect(errors).toHaveLength(0);
  });

  it('accepts optional pricing, context window, and parameter schema reference', async () => {
    const errors = await validate(
      toDto({
        model_name: 'claude-secret',
        input_price_per_million_tokens: 3,
        output_price_per_million_tokens: 15,
        context_window: 200000,
        param_schema_ref: {
          provider: 'anthropic',
          authType: 'api_key',
          model: 'claude-sonnet-4-6',
        },
        param_defaults: { temperature: 0.2, vendor: { reasoning: true } },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty model name', async () => {
    const errors = await validate(toDto({ model_name: '' }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('coerces numeric fields sent as query strings', async () => {
    const dto = toDto({
      model_name: 'claude-secret',
      input_price_per_million_tokens: '3',
      context_window: '200000',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.input_price_per_million_tokens).toBe(3);
    expect(dto.context_window).toBe(200000);
  });

  it('rejects a negative input price', async () => {
    const errors = await validate(
      toDto({ model_name: 'claude-secret', input_price_per_million_tokens: -1 }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a context window below 1', async () => {
    const errors = await validate(toDto({ model_name: 'claude-secret', context_window: 0 }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts manual model settings without a model name', async () => {
    const dto = plainToInstance(ManualModelSettingsDto, {
      param_schema_ref: { provider: 'zai', authType: 'api_key', model: 'glm-5.1' },
      param_defaults: { temperature: 0.2 },
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects array parameter defaults', async () => {
    const errors = await validate(
      toDto({ model_name: 'claude-secret', param_defaults: ['temperature'] }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid parameter schema auth type', async () => {
    const errors = await validate(
      toDto({
        model_name: 'claude-secret',
        param_schema_ref: { provider: 'anthropic', authType: 'bad', model: 'claude-sonnet-4-6' },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
