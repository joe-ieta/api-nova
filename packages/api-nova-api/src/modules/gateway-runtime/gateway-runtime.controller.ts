import { All, Controller, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { GatewayRuntimeService } from './services/gateway-runtime.service';

@ApiExcludeController()
@Controller('v1/gateway')
export class GatewayRuntimeController {
  constructor(private readonly gatewayRuntimeService: GatewayRuntimeService) {}

  @All(':routePath(*)')
  async forwardGatewayRequest(
    @Param('routePath') routePath: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.gatewayRuntimeService.forwardRequest(`/${routePath}`, req);
    const contentType = result.headers['content-type'];
    if (contentType) {
      res.setHeader('content-type', contentType);
    }
    return res.status(result.status).send(result.data);
  }
}
