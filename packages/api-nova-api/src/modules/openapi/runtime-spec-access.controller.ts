import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LoggingInterceptor } from '../../common/interceptors/logging.interceptor';
import { RuntimeSpecAccessGuard } from './guards/runtime-spec-access.guard';
import { OpenAPIService } from './services/openapi.service';

@ApiTags('OpenAPI')
@Controller('openapi')
@UseInterceptors(LoggingInterceptor)
export class RuntimeSpecAccessController {
  private readonly logger = new Logger(RuntimeSpecAccessController.name);

  constructor(private readonly openApiService: OpenAPIService) {}

  @Get('by-runtime-asset/:runtimeAssetId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RuntimeSpecAccessGuard)
  @ApiOperation({
    summary: 'Get assembled OpenAPI document by runtime asset ID',
    description:
      'Retrieve the assembled OpenAPI document for one runtime asset. Management JWT or the owning spawned runtime spec-access credential is required.',
  })
  @ApiParam({
    name: 'runtimeAssetId',
    description: 'Runtime Asset ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'OpenAPI document retrieved successfully',
    schema: {
      type: 'object',
      description: 'OpenAPI specification document',
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing, invalid or expired credential',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Credential belongs to another runtime asset',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Runtime asset not found or no OpenAPI document available',
  })
  async getOpenApiByRuntimeAssetId(@Param('runtimeAssetId') runtimeAssetId: string) {
    try {
      this.logger.log(`Retrieving assembled OpenAPI document for runtime asset ID: ${runtimeAssetId}`);
      return await this.openApiService.getOpenApiByRuntimeAssetId(runtimeAssetId);
    } catch (error) {
      this.logger.error(
        `Failed to retrieve assembled OpenAPI document for runtime asset ID ${runtimeAssetId}: ${error.message}`,
        error.stack,
      );

      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException('Failed to retrieve assembled OpenAPI document');
    }
  }
}
