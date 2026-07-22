import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { RuntimeVerificationTrigger } from '../../../database/entities/runtime-verification-run.entity';

export class PlanRuntimeVerificationDto {
  @ApiPropertyOptional({ enum: RuntimeVerificationTrigger })
  @IsOptional()
  @IsEnum(RuntimeVerificationTrigger)
  trigger?: RuntimeVerificationTrigger;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  includeRegression?: boolean;

  @ApiPropertyOptional({
    minLength: 10,
    maxLength: 1000,
    description: 'Authorized operator reason for deploying without a smoke sample',
  })
  @IsOptional()
  @IsString()
  @Length(10, 1000)
  missingSmokeWaiverReason?: string;
}
