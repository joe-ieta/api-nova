import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class QuickPublishDocumentMcpDto {
  @ApiPropertyOptional({
    description: 'Latest document content from the editor. When provided, it will be persisted before publishing.',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    description: 'Replace existing MCP runtime asset with the same publication name',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  replaceExisting?: boolean;
}
