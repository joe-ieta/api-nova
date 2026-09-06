import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';
import * as cors from 'cors';
import * as helmet from 'helmet';
import * as compression from 'compression';
import * as express from 'express';
import * as path from 'path';
import { existsSync } from 'fs';
import { flushRuntimeAudit, runtimeMetadata } from 'api-nova-parser';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  try {
    const app = await NestFactory.create(AppModule, {
      // Parsers below deliberately exclude the streaming Gateway path. Do not let
      // Nest append its default JSON parser and drain that stream afterwards.
      bodyParser: false,
      logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    // 配置Socket.IO适配器
    app.useWebSocketAdapter(new IoAdapter(app));

    const configService = app.get(ConfigService);

    // 配置请求体大小限制
    const maxPayloadSize = configService.get<string>('MAX_PAYLOAD_SIZE', '50mb');
    const jsonParser = express.json({ limit: maxPayloadSize });
    const urlencodedParser = express.urlencoded({ limit: maxPayloadSize, extended: true });
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/v1/gateway/')) {
        return next();
      }
      return jsonParser(req, res, next);
    });
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/v1/gateway/')) {
        return next();
      }
      return urlencodedParser(req, res, next);
    });

    // 安全中间件
    app.use(helmet.default({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
    }));
    
    app.use(compression());

    // 静态文件服务
    const publicDir = path.resolve(process.cwd(), 'public');
    const indexFile = path.join(publicDir, 'index.html');

    // Serve the packaged UI from the runtime working directory.
    if (existsSync(publicDir)) {
      app.use(express.static(publicDir, { index: false }));
    }

    // CORS配置
    const corsOrigins = configService
      .get<string>(
        'CORS_ORIGINS',
        'http://localhost:5173,http://localhost:9000,http://127.0.0.1:9000',
      )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    app.use(cors({
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
      allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'x-api-key',
        'x-request-id',
        'x-correlation-id',
        'mcp-session-id',
        'accept',
        'origin',
        'x-requested-with'
      ],
      exposedHeaders: ['WWW-Authenticate', 'X-Request-Id'],
    }));

    // 全局前缀
    app.setGlobalPrefix('api', {
      exclude: ['/', '/health', '/metrics', '/favicon.ico']
    });

    const expressInstance = app.getHttpAdapter().getInstance();
    expressInstance.get(/^\/\.well-known\/oauth-protected-resource(?:\/.*)?$/, (_req, res) => {
      try { res.setHeader('Cache-Control', 'no-store'); res.json(runtimeMetadata('gateway')); }
      catch { res.status(503).json({ error: 'runtime_auth_not_configured' }); }
    });
    const spaFallbackPattern =
      /^\/(?!(api|socket\.io|monitoring|health|metrics|assets)(\/|$)|favicon\.ico$|vite\.svg$).*/;

    expressInstance.get(spaFallbackPattern, (_req, res, next) => {
      if (!existsSync(indexFile)) {
        return next();
      }

      return res.sendFile(indexFile);
    });

    // 全局验证管道
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
        errorHttpStatusCode: 422,
      })
    );

    // Swagger文档配置
    if (configService.get<string>('NODE_ENV') !== 'production') {
      const config = new DocumentBuilder()
        .setTitle('ApiNova API')
        .setDescription(`
          API服务器用于管理OpenAPI规范到MCP工具的转换和动态服务器管理。
          
          ## 主要功能
          - OpenAPI规范解析和验证
          - 动态MCP工具生成
          - MCP服务器管理
          - 实时协议处理
          
          ## 认证方式
          使用JWT Bearer Token认证，请在请求头中添加 Authorization: Bearer <token>
        `)
        .setVersion('1.0')
        .addServer(`http://localhost:${configService.get<number>('PORT', 9001)}`, 'Development')
        .addBearerAuth(
          {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT令牌认证'
          },
          'JWT'
        )
        .addTag('OpenAPI', 'OpenAPI规范管理')
        .addTag('MCP', 'MCP协议处理')
        .addTag('Health', '健康检查')
        .addTag('Config', '配置管理')
        .build();

      const document = SwaggerModule.createDocument(app, config);

      // 强制所有接口都加上 security 字段，确保Swagger UI调试时自动携带 JWT
      Object.values(document.paths).forEach((pathItem: any) => {
        ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].forEach(method => {
          if (pathItem[method]) {
            if (!pathItem[method].security) {
              pathItem[method].security = [{ JWT: [] }];
            }
          }
        });
      });

      SwaggerModule.setup('api/docs', app, document, {
        swaggerOptions: {
          persistAuthorization: true,
          displayRequestDuration: true,
          filter: true,
          tryItOutEnabled: true,
        },
        customSiteTitle: 'ApiNova API Documentation',
        customfavIcon: '/favicon.ico',
      });

      logger.log(`📚 Swagger documentation available at: http://localhost:${configService.get<number>('PORT', 9001)}/api/docs`);
    }

    // 启动应用
    const port = configService.get<number>('PORT', 9001);
    await app.listen(port, '0.0.0.0');

    logger.log(`🚀 Application is running on: http://localhost:${port}/api/docs`);
    logger.log(`🏥 Health check available at: http://localhost:${port}/health`);
    logger.log(`🎛️ MCP Server running on port: ${configService.get<number>('MCP_PORT', 9022)}`);
    
    // 优雅关闭处理
    process.on('SIGTERM', async () => {
      logger.log('🛑 SIGTERM received, shutting down gracefully');
      await app.close();
      await flushRuntimeAudit();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.log('🛑 SIGINT received, shutting down gracefully');
      await app.close();
      await flushRuntimeAudit();
      process.exit(0);
    });

  } catch (error) {
    logger.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap();
