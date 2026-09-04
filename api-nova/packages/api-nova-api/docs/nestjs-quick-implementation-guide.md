# NestJS 快速实施指南

## 🚀 快速开始

### 前置检查
```bash
# 检查Node.js版本
node --version  # 需要 >= 18.0.0

# 检查pnpm版本
pnpm --version  # 需要 >= 8.0.0

# 检查当前目录
pwd  # 应该在 /api-nova-server/packages/api-nova-api
```

### 1. 初始化项目 (5分钟)

```bash
# 进入API项目目录
cd packages/api-nova-api

# 初始化NestJS项目
npx @nestjs/cli new . --skip-git --package-manager pnpm

# 安装核心依赖
pnpm add @nestjs/config @nestjs/swagger @nestjs/terminus
pnpm add class-validator class-transformer
pnpm add cors helmet compression

# 安装开发依赖
pnpm add -D @types/cors @types/compression supertest

# 安装现有项目依赖
pnpm add api-nova-parser@workspace:*
```

### 2. 项目结构创建 (3分钟)

```bash
# 创建核心目录结构
mkdir -p src/{modules,common,utils}
mkdir -p src/modules/{mcp,openapi,health}
mkdir -p src/modules/mcp/{controllers,services,dto,interfaces}
mkdir -p src/modules/openapi/{services,dto}
mkdir -p src/modules/health/{controllers}
mkdir -p src/common/{guards,interceptors,filters,pipes,decorators}
mkdir -p test/mcp

# 创建配置文件
touch .env.example .env.development .env.production
```

## 📁 核心文件实现

### 1. 应用入口 (main.ts)
```typescript
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import * as cors from 'cors';
import * as helmet from 'helmet';
import * as compression from 'compression';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 安全中间件
  app.use(helmet());
  app.use(compression());

  // CORS配置
  app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'mcp-session-id'],
  }));

  // 全局前缀
  app.setGlobalPrefix('api');

  // 全局验证管道
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );

  // Swagger文档
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('ApiNova API')
      .setDescription('API for managing OpenAPI to MCP conversion')
      .setVersion('1.0')
      .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'apiKey')
      .build();
    
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 9001;
  await app.listen(port);
  
  console.log(`🚀 Application is running on: http://localhost:${port}`);
  console.log(`📚 Swagger docs available at: http://localhost:${port}/api/docs`);
}

bootstrap();
```

### 2. 根模块 (app.module.ts)
```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

// 功能模块
import { MCPModule } from './modules/mcp/mcp.module';
import { OpenAPIModule } from './modules/openapi/openapi.module';
import { HealthModule } from './modules/health/health.module';

// 全局组件
import { MCPExceptionFilter } from './common/filters/mcp-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ApiKeyGuard } from './common/guards/api-key.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.development', '.env'],
    }),
    MCPModule,
    OpenAPIModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: MCPExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AppModule {}
```

### 3. MCP模块 (mcp.module.ts)
```typescript
// src/modules/mcp/mcp.module.ts
import { Module } from '@nestjs/common';
import { MCPController } from './controllers/mcp.controller';
import { MCPService } from './services/mcp.service';
import { DynamicServerService } from './services/dynamic-server.service';
import { OpenAPIModule } from '../openapi/openapi.module';

@Module({
  imports: [OpenAPIModule],
  controllers: [MCPController],
  providers: [MCPService, DynamicServerService],
  exports: [MCPService, DynamicServerService],
})
export class MCPModule {}
```

### 4. MCP控制器 (mcp.controller.ts)
```typescript
// src/modules/mcp/controllers/mcp.controller.ts
import { Controller, Post, Get, Body, Headers, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { MCPService } from '../services/mcp.service';
import { MCPRequestDto, MCPResponseDto, ConfigureRequestDto, ConfigureResponseDto } from '../dto';
import { MCPSessionGuard } from '../../../common/guards/mcp-session.guard';

@ApiTags('MCP Protocol')
@Controller()
export class MCPController {
  constructor(private readonly mcpService: MCPService) {}

  @Post('configure')
  @ApiOperation({ summary: '配置OpenAPI规范并生成MCP工具' })
  @ApiBody({ type: ConfigureRequestDto })
  @ApiResponse({ status: 200, type: ConfigureResponseDto })
  async configure(@Body() request: ConfigureRequestDto): Promise<ConfigureResponseDto> {
    return this.mcpService.configure(request);
  }

  @Get('status')
  @ApiOperation({ summary: '获取MCP服务器状态' })
  async getStatus() {
    return this.mcpService.getStatus();
  }

  @Get('tools')
  @ApiOperation({ summary: '获取当前可用工具列表' })
  async getTools() {
    return this.mcpService.getTools();
  }

  @Post('mcp')
  @ApiOperation({ summary: '处理MCP协议请求' })
  @ApiSecurity('apiKey')
  @UseGuards(MCPSessionGuard)
  @ApiBody({ type: MCPRequestDto })
  @ApiResponse({ status: 200, type: MCPResponseDto })
  async handleMCP(
    @Body() request: MCPRequestDto,
    @Headers('mcp-session-id') sessionId?: string
  ): Promise<MCPResponseDto> {
    return this.mcpService.handleMCPRequest(request, sessionId);
  }

  @Post('test-tool')
  @ApiOperation({ summary: '测试工具调用' })
  async testTool(@Body() request: { toolName: string; arguments: any }) {
    return this.mcpService.testTool(request.toolName, request.arguments);
  }
}
```

### 5. MCP服务 (mcp.service.ts)
```typescript
// src/modules/mcp/services/mcp.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamicServerService } from './dynamic-server.service';
import { OpenAPIService } from '../../openapi/services/openapi.service';
import { 
  ConfigureRequestDto, 
  ConfigureResponseDto, 
  MCPRequestDto, 
  MCPResponseDto 
} from '../dto';

@Injectable()
export class MCPService {
  private readonly logger = new Logger(MCPService.name);

  constructor(
    private readonly dynamicServerService: DynamicServerService,
    private readonly openApiService: OpenAPIService,
    private readonly configService: ConfigService,
  ) {}

  async configure(request: ConfigureRequestDto): Promise<ConfigureResponseDto> {
    this.logger.log('配置OpenAPI规范...');

    try {
      // 解析OpenAPI规范
      const parseResult = await this.openApiService.parseOpenAPI(request.source);
      
      // 动态配置MCP工具
      const configResult = await this.dynamicServerService.loadOpenAPISpec(
        request.source,
        request.baseUrl
      );

      return {
        success: true,
        data: {
          ...configResult,
          mcpServerUrl: `http://localhost:${this.configService.get('MCP_PORT', 9022)}/mcp`,
          configuredAt: new Date().toISOString(),
        }
      };

    } catch (error) {
      this.logger.error('配置失败:', error);
      throw error;
    }
  }

  async getStatus() {
    const tools = this.dynamicServerService.getCurrentTools();
    const spec = this.dynamicServerService.getCurrentSpec();

    return {
      success: true,
      data: {
        mcpServerRunning: true,
        mcpServerUrl: `http://localhost:${this.configService.get('MCP_PORT', 9022)}/mcp`,
        configApiUrl: `http://localhost:${this.configService.get('PORT', 9001)}`,
        toolsCount: tools.length,
        hasConfiguration: !!spec,
        apiTitle: spec?.info?.title || null,
        lastUpdate: new Date().toISOString(),
      }
    };
  }

  async getTools() {
    const tools = this.dynamicServerService.getCurrentTools();
    
    return {
      success: true,
      data: {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          metadata: tool.metadata,
        })),
        count: tools.length,
      }
    };
  }

  async handleMCPRequest(request: MCPRequestDto, sessionId?: string): Promise<MCPResponseDto> {
    this.logger.log(`处理MCP请求: ${request.method}`);
    
    try {
      // 这里集成现有的MCP服务器逻辑
      const result = await this.dynamicServerService.handleMCPRequest(request, sessionId);
      return result;
    } catch (error) {
      this.logger.error('MCP请求处理失败:', error);
      throw error;
    }
  }

  async testTool(toolName: string, args: any) {
    this.logger.log(`测试工具: ${toolName}`);
    
    try {
      const result = await this.dynamicServerService.testTool(toolName, args);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      this.logger.error(`工具测试失败: ${toolName}`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
```

### 6. DTO定义 (dto/index.ts)
```typescript
// src/modules/mcp/dto/index.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, IsOptional, IsUrl, IsNumber, IsDateString, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

// 输入源DTO
export class InputSourceDto {
  @ApiProperty({ description: '输入类型', enum: ['url', 'file', 'text'] })
  @IsString()
  type: 'url' | 'file' | 'text';

  @ApiProperty({ description: '输入内容' })
  @IsString()
  content: string;

  @ApiProperty({ description: '编码格式', required: false })
  @IsOptional()
  @IsString()
  encoding?: string;
}

// 配置请求DTO
export class ConfigureRequestDto {
  @ApiProperty({ description: '输入源' })
  @IsObject()
  @Type(() => InputSourceDto)
  source: InputSourceDto;

  @ApiProperty({ description: '基础URL', required: false })
  @IsOptional()
  @IsUrl()
  baseUrl?: string;

  @ApiProperty({ description: '配置选项', required: false })
  @IsOptional()
  @IsObject()
  options?: any;
}

// 配置响应DTO
export class ConfigureResponseDto {
  @ApiProperty({ description: '是否成功' })
  @IsBoolean()
  success: boolean;

  @ApiProperty({ description: '响应数据' })
  data: {
    apiInfo: any;
    endpoints: any[];
    toolsCount: number;
    mcpServerUrl: string;
    configuredAt: string;
  };
}

// MCP请求DTO
export class MCPRequestDto {
  @ApiProperty({ description: 'JSON-RPC版本' })
  @IsString()
  jsonrpc: string;

  @ApiProperty({ description: '请求ID' })
  id: string | number;

  @ApiProperty({ description: '方法名' })
  @IsString()
  method: string;

  @ApiProperty({ description: '参数', required: false })
  @IsOptional()
  params?: any;
}

// MCP响应DTO
export class MCPResponseDto {
  @ApiProperty({ description: 'JSON-RPC版本' })
  @IsString()
  jsonrpc: string;

  @ApiProperty({ description: '请求ID' })
  id: string | number;

  @ApiProperty({ description: '结果', required: false })
  @IsOptional()
  result?: any;

  @ApiProperty({ description: '错误', required: false })
  @IsOptional()
  error?: any;
}
```

## 🔧 配置文件

### 环境变量配置
```bash
# .env.development
NODE_ENV=development
PORT=9001
MCP_PORT=9022

# CORS配置
CORS_ORIGINS=http://localhost:5173,http://localhost:9000

# 安全配置 (开发环境可选)
API_KEY=

# 日志配置
LOG_LEVEL=debug

# 监控配置
HEALTH_CHECK_ENABLED=true
```

### package.json脚本
```json
{
  "scripts": {
    "prebuild": "rimraf dist",
    "build": "nest build",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main",
    "lint": "eslint \"{src,apps,libs,test}/**/*.ts\" --fix",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:debug": "node --inspect-brk -r tsconfig-paths/register -r ts-node/register node_modules/.bin/jest --runInBand",
    "test:e2e": "jest --config ./test/jest-e2e.json"
  }
}
```

## 🚀 启动流程

### 1. 开发模式启动
```bash
# 启动API服务
pnpm run start:dev

# 验证服务状态
curl http://localhost:9001/api/health
curl http://localhost:9001/api/status

# 查看Swagger文档
open http://localhost:9001/api/docs
```

### 2. 与前端联调
```bash
# 在项目根目录
cd ../../

# 同时启动前端和后端
pnpm run dev:full
```

### 3. 测试API功能
```bash
# 测试配置接口
curl -X POST http://localhost:9001/api/configure \
  -H "Content-Type: application/json" \
  -d '{
    "source": {
      "type": "url",
      "content": "https://petstore.swagger.io/v2/swagger.json"
    }
  }'

# 查看工具列表
curl http://localhost:9001/api/tools
```

## 📋 验收检查清单

### ✅ 基础功能验收
- [ ] 服务启动成功 (端口9001)
- [ ] Swagger文档可访问
- [ ] 健康检查接口正常
- [ ] CORS配置正确

### ✅ API功能验收
- [ ] 配置接口工作正常
- [ ] 状态查询接口正常
- [ ] 工具列表接口正常
- [ ] MCP协议接口正常

### ✅ 集成验收
- [ ] 与前端UI正常通信
- [ ] 与api-nova-parser集成正常
- [ ] 与现有MCP服务器集成正常

### ✅ 错误处理验收
- [ ] 输入验证正常
- [ ] 错误响应格式正确
- [ ] 异常处理不会崩溃

## 🔄 后续优化

### 短期优化 (1-2周)
1. 添加请求限流
2. 完善错误处理
3. 添加更多单元测试
4. 优化日志格式

### 中期优化 (1个月)
1. 添加缓存机制
2. 实现配置持久化
3. 添加性能监控
4. 优化内存使用

### 长期优化 (3个月)
1. 支持分布式部署
2. 添加用户认证
3. 实现API版本管理
4. 集成第三方监控系统

这个快速实施指南提供了完整的NestJS项目搭建流程，可以在1-2小时内完成基础架构搭建，并快速集成到现有项目中。
