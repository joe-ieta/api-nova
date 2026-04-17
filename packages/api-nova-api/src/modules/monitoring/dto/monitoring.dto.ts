import { ApiProperty } from '@nestjs/swagger';

import { SystemLogResponseDto } from '../../servers/dto/system-log.dto';

export class MonitoringApiEnvelopeDto {
  @ApiProperty({ example: 'success' })
  status: string;
}

export class ManagementAuditStatsDto {
  @ApiProperty()
  totalLogs: number;

  @ApiProperty()
  successLogs: number;

  @ApiProperty()
  failedLogs: number;

  @ApiProperty()
  warningLogs: number;

  @ApiProperty()
  errorLogs: number;

  @ApiProperty()
  successRate: number | string;
}

export class ManagementOverviewDataDto {
  @ApiProperty({ type: 'object' })
  metrics: any;

  @ApiProperty({ type: 'object' })
  health: any;

  @ApiProperty({ type: ManagementAuditStatsDto })
  auditStats: ManagementAuditStatsDto;

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  recentRuntimeEvents: any[];

  @ApiProperty({ type: [SystemLogResponseDto] })
  recentManagementLogs: SystemLogResponseDto[];
}

export class ManagementOverviewResponseDto extends MonitoringApiEnvelopeDto {
  @ApiProperty({ type: ManagementOverviewDataDto })
  data: ManagementOverviewDataDto;
}

export class ManagementEventsResponseDto extends MonitoringApiEnvelopeDto {
  @ApiProperty({ type: 'object' })
  data: any;
}

export class ManagementAuditResponseDto extends MonitoringApiEnvelopeDto {
  @ApiProperty({ type: 'object' })
  data: any;
}
