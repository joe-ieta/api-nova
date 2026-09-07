import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class LoggingConfigUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  level?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  format?: string;
}

class PerformanceConfigUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  requestTimeout?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(86400)
  cacheTtl?: number;
}

class ProcessConfigUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  timeout?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  maxRetries?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(60000)
  restartDelay?: number;
}

class RuntimeConfigUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  apiBaseUrl?: string;
}

class McpConfigUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(600000)
  serverTimeout?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(600000)
  healthCheckInterval?: number;
}

class OpenApiConfigUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultBaseUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(86400)
  cacheTtl?: number;
}

class MonitoringConfigUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  metricsEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(60000)
  @Max(31536000000)
  metricsHistoryMaxAge?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  healthCheckEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(600000)
  healthCheckInterval?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(600000)
  healthCheckTimeout?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(60000)
  @Max(31536000000)
  healthCheckHistoryMaxAge?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoRestartUnhealthyServers?: boolean;
}

export class UpdateApplicationConfigDto {
  @ApiPropertyOptional({ type: LoggingConfigUpdateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LoggingConfigUpdateDto)
  logging?: LoggingConfigUpdateDto;

  @ApiPropertyOptional({ type: PerformanceConfigUpdateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PerformanceConfigUpdateDto)
  performance?: PerformanceConfigUpdateDto;

  @ApiPropertyOptional({ type: ProcessConfigUpdateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProcessConfigUpdateDto)
  process?: ProcessConfigUpdateDto;

  @ApiPropertyOptional({ type: RuntimeConfigUpdateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RuntimeConfigUpdateDto)
  runtime?: RuntimeConfigUpdateDto;

  @ApiPropertyOptional({ type: McpConfigUpdateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => McpConfigUpdateDto)
  mcp?: McpConfigUpdateDto;

  @ApiPropertyOptional({ type: OpenApiConfigUpdateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OpenApiConfigUpdateDto)
  openapi?: OpenApiConfigUpdateDto;

  @ApiPropertyOptional({ type: MonitoringConfigUpdateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MonitoringConfigUpdateDto)
  monitoring?: MonitoringConfigUpdateDto;
}
