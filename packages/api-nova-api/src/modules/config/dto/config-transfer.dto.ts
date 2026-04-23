import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApplicationConfigResponseDto } from './config-response.dto';

export class ConfigTransferOverrideDto {
  @ApiProperty()
  envKey: string;

  @ApiProperty()
  section: string;

  @ApiProperty()
  field: string;

  @ApiProperty({ enum: ['string', 'number', 'boolean'] })
  valueType: 'string' | 'number' | 'boolean';

  @ApiProperty()
  value: string | number | boolean;

  @ApiProperty()
  restartRequired: boolean;

  @ApiPropertyOptional()
  description?: string;
}

export class ConfigExportDto {
  @ApiProperty({ default: 'config-overrides/v1' })
  formatVersion: string;

  @ApiProperty()
  exportedAt: string;

  @ApiProperty({ type: [ConfigTransferOverrideDto] })
  overrides: ConfigTransferOverrideDto[];

  @ApiProperty()
  overrideCount: number;
}

export class ImportApplicationConfigDto {
  @ApiProperty({ default: 'config-overrides/v1' })
  @IsString()
  formatVersion: string;

  @ApiProperty({ type: [ConfigTransferOverrideDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfigTransferOverrideDto)
  overrides: ConfigTransferOverrideDto[];
}

export class CreateConfigBackupDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class ConfigBackupSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty()
  overrideCount: number;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

export class ConfigImportResultDto {
  @ApiProperty()
  importedCount: number;

  @ApiProperty({ type: [String] })
  restartRequiredKeys: string[];

  @ApiProperty({ type: [String] })
  restartPlan: string[];

  @ApiProperty({ type: ApplicationConfigResponseDto })
  config: ApplicationConfigResponseDto;
}

export class ConfigImportPreviewConflictDto {
  @ApiProperty()
  key: string;

  @ApiPropertyOptional()
  currentValue?: string | number | boolean;

  @ApiPropertyOptional()
  incomingValue?: string | number | boolean;

  @ApiProperty({ enum: ['add', 'change', 'remove'] })
  kind: 'add' | 'change' | 'remove';
}

export class ConfigImportPreviewDto {
  @ApiProperty()
  formatVersion: string;

  @ApiProperty()
  compatible: boolean;

  @ApiProperty()
  migrationRequired: boolean;

  @ApiProperty({ type: [ConfigImportPreviewConflictDto] })
  conflicts: ConfigImportPreviewConflictDto[];

  @ApiProperty({ type: [String] })
  restartRequiredKeys: string[];

  @ApiProperty({ type: [String] })
  restartPlan: string[];
}
