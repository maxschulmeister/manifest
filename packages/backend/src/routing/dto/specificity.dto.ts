import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsBoolean,
  ValidateNested,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { AUTH_TYPES } from 'manifest-shared';
import {
  HeaderTierFallbackRefDto,
  ModelRouteDto,
  MAX_PROVIDER_KEY_LABEL_LENGTH,
} from './routing.dto';

export class SetSpecificityOverrideDto {
  @ValidateIf((body) => !body.route && !body.target)
  @IsString()
  @IsNotEmpty()
  model?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription' | 'local';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  providerKeyLabel?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ModelRouteDto)
  route?: ModelRouteDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => HeaderTierFallbackRefDto)
  target?: HeaderTierFallbackRefDto;
}

export class ToggleSpecificityDto {
  @IsBoolean()
  active!: boolean;
}
