import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  MaxLength,
  IsIn,
  ValidateNested,
  IsObject,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AUTH_TYPES, type AuthType, type RequestParamDefaults } from 'manifest-shared';

/**
 * A single model the operator adds to an integrated provider because the
 * provider's `/models` endpoint omits it. Mirrors the shape of a custom-
 * provider model entry. Optional pricing/context default through the same
 * enrichment path as discovered models (models.dev / OpenRouter / known
 * prices).
 */
export class ParamSchemaRefDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsIn(AUTH_TYPES)
  authType!: AuthType;

  @IsString()
  @IsNotEmpty()
  model!: string;
}

const MAX_REQUEST_PARAM_DEPTH = 100;

@ValidatorConstraint({ name: 'manualModelParamDefaults', async: false })
class ManualModelParamDefaultsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isJsonObject(value);
  }

  defaultMessage(): string {
    return 'param_defaults must be a JSON object';
  }
}

export class ManualModelSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ParamSchemaRefDto)
  param_schema_ref?: ParamSchemaRefDto | null;

  @IsOptional()
  @IsObject()
  @Validate(ManualModelParamDefaultsConstraint)
  param_defaults?: RequestParamDefaults | null;
}

export class ManualModelDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model_name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  input_price_per_million_tokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  output_price_per_million_tokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  context_window?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ParamSchemaRefDto)
  param_schema_ref?: ParamSchemaRefDto | null;

  @IsOptional()
  @IsObject()
  @Validate(ManualModelParamDefaultsConstraint)
  param_defaults?: RequestParamDefaults | null;
}

function isJsonObject(value: unknown, depth = 0): value is Record<string, unknown> {
  if (depth > MAX_REQUEST_PARAM_DEPTH) return false;
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_REQUEST_PARAM_DEPTH) return false;
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isJsonObject(value, depth);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
