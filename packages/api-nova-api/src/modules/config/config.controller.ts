import { Body, Controller, Delete, Get, Logger, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AppConfigService } from '../../config/app-config.service';
import {
  ApplicationConfigResponseDto,
  EnvironmentInfoResponseDto,
  UpdateApplicationConfigResponseDto,
} from './dto/config-response.dto';
import { UpdateApplicationConfigDto } from './dto/config-update.dto';
import {
  ConfigBackupSummaryDto,
  ConfigExportDto,
  ConfigImportPreviewDto,
  ConfigImportResultDto,
  CreateConfigBackupDto,
  ImportApplicationConfigDto,
} from './dto/config-transfer.dto';

@ApiTags('Configuration')
@Controller('v1/config')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ConfigController {
  private readonly logger = new Logger(ConfigController.name);

  constructor(private readonly configService: AppConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Get application configuration',
    description: 'Get the current application configuration (safe values only)',
  })
  @ApiOkResponse({
    description: 'Application configuration',
    type: ApplicationConfigResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - Invalid or missing API key',
  })
  async getConfig(): Promise<ApplicationConfigResponseDto> {
    try {
      this.logger.log('Getting application configuration');

      const config = this.configService.getAllConfig();

      this.logger.log('Successfully retrieved application configuration');

      return config;
    } catch (error) {
      this.logger.error(`Failed to get configuration: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('environment')
  @ApiOperation({
    summary: 'Get environment information',
    description: 'Get basic environment information',
  })
  @ApiOkResponse({
    description: 'Environment information',
    type: EnvironmentInfoResponseDto,
  })
  async getEnvironment(): Promise<EnvironmentInfoResponseDto> {
    try {
      this.logger.debug('Getting environment information');

      return {
        nodeEnv: this.configService.nodeEnv,
        port: this.configService.port,
        mcpPort: this.configService.mcpPort,
        isDevelopment: this.configService.isDevelopment,
        isProduction: this.configService.isProduction,
        isTest: this.configService.isTest,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Failed to get environment info: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Patch()
  @ApiOperation({
    summary: 'Update runtime-tunable configuration',
    description:
      'Persist supported configuration overrides and return the latest effective snapshot.',
  })
  @ApiBody({ type: UpdateApplicationConfigDto })
  @ApiOkResponse({
    description: 'Updated application configuration with change summary',
    type: UpdateApplicationConfigResponseDto,
  })
  async updateConfig(
    @Body() dto: UpdateApplicationConfigDto,
  ): Promise<UpdateApplicationConfigResponseDto> {
    try {
      this.logger.log('Updating application configuration');
      const result = await this.configService.updateConfig(dto);
      this.logger.log(
        `Updated application configuration fields: ${result.updatedKeys.join(', ') || 'none'}`,
      );
      return result;
    } catch (error) {
      this.logger.error(`Failed to update configuration: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('export')
  @ApiOperation({
    summary: 'Export current configuration overrides',
    description: 'Export persisted configuration overrides in a portable JSON structure.',
  })
  @ApiOkResponse({
    description: 'Exported configuration overrides',
    type: ConfigExportDto,
  })
  getConfigExport(): ConfigExportDto {
    return this.configService.exportConfig();
  }

  @Patch('import')
  @ApiOperation({
    summary: 'Import configuration overrides',
    description: 'Replace current persisted configuration overrides with an imported payload.',
  })
  @ApiBody({ type: ImportApplicationConfigDto })
  @ApiOkResponse({
    description: 'Import result',
    type: ConfigImportResultDto,
  })
  async importConfig(
    @Body() dto: ImportApplicationConfigDto,
  ): Promise<ConfigImportResultDto> {
    return this.configService.importConfig(dto);
  }

  @Patch('import/preview')
  @ApiOperation({
    summary: 'Preview configuration import conflicts',
    description: 'Compare an import payload with the current overrides and return conflict and restart impact details.',
  })
  @ApiBody({ type: ImportApplicationConfigDto })
  @ApiOkResponse({
    description: 'Import preview',
    type: ConfigImportPreviewDto,
  })
  previewImportConfig(
    @Body() dto: ImportApplicationConfigDto,
  ): ConfigImportPreviewDto {
    return this.configService.previewImportConfig(dto);
  }

  @Get('backups')
  @ApiOperation({
    summary: 'List configuration backups',
    description: 'Return persisted configuration backups.',
  })
  @ApiOkResponse({
    description: 'Configuration backups',
    type: ConfigBackupSummaryDto,
    isArray: true,
  })
  async listBackups(): Promise<ConfigBackupSummaryDto[]> {
    return this.configService.listBackups();
  }

  @Patch('backups')
  @ApiOperation({
    summary: 'Create a configuration backup',
    description: 'Persist the current configuration override snapshot as a named backup.',
  })
  @ApiBody({ type: CreateConfigBackupDto })
  @ApiOkResponse({
    description: 'Created backup summary',
    type: ConfigBackupSummaryDto,
  })
  async createBackup(
    @Body() dto: CreateConfigBackupDto,
  ): Promise<ConfigBackupSummaryDto> {
    return this.configService.createBackup(dto);
  }

  @Patch('backups/:id/restore')
  @ApiOperation({
    summary: 'Restore a configuration backup',
    description: 'Replace current configuration overrides with the selected backup snapshot.',
  })
  @ApiOkResponse({
    description: 'Restore result',
    type: ConfigImportResultDto,
  })
  async restoreBackup(
    @Param('id') id: string,
  ): Promise<ConfigImportResultDto> {
    return this.configService.restoreBackup(id);
  }

  @Delete('backups/:id')
  @ApiOperation({
    summary: 'Delete a configuration backup',
    description: 'Delete a persisted configuration backup snapshot.',
  })
  async deleteBackup(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.configService.deleteBackup(id);
    return { success: true };
  }
}
