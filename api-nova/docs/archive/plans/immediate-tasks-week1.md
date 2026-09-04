# 立即执行任务清单 - 第一周开发计划

## 🎯 本周目标
完成后端 HTTP API 服务器的基础实现，实现前后端基本集成。

---

## 📋 Day 1-2: 后端 HTTP API 服务器基础架构

### 任务 1.1: 安装必要依赖
```bash
cd packages/api-nova-server
npm install express cors zod swagger-parser
npm install -D @types/express @types/cors @types/node
```

### 任务 1.2: 创建 HTTP API 服务器

**创建文件: `packages/api-nova-server/src/api/server.ts`**
```typescript
import express from 'express'
import cors from 'cors'
import { validateRoute } from './routes/validate'
import { previewRoute } from './routes/preview'
import { convertRoute } from './routes/convert'
import { errorHandler } from './middleware/error'

export function createHttpApiServer(port = 3322) {
  const app = express()
  
  // 中间件
  app.use(cors({
    origin: ['http://localhost:9000', 'http://127.0.0.1:9000'],
    credentials: true
  }))
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true }))
  
  // 健康检查
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })
  
  // API 路由
  app.use('/api/validate', validateRoute)
  app.use('/api/preview', previewRoute)
  app.use('/api/convert', convertRoute)
  
  // 错误处理
  app.use(errorHandler)
  
  return app
}

// 启动服务器
export function startHttpServer(port = 3322) {
  const app = createHttpApiServer(port)
  
  app.listen(port, () => {
    console.log(`🚀 HTTP API Server running on http://localhost:${port}`)
    console.log(`📊 Health check: http://localhost:${port}/health`)
  })
  
  return app
}
```

### 任务 1.3: 创建错误处理中间件

**创建文件: `packages/api-nova-server/src/api/middleware/error.ts`**
```typescript
import { Request, Response, NextFunction } from 'express'

export interface ApiError extends Error {
  statusCode?: number
  code?: string
  details?: any
}

export function createError(message: string, statusCode = 500, code?: string, details?: any): ApiError {
  const error = new Error(message) as ApiError
  error.statusCode = statusCode
  error.code = code
  error.details = details
  return error
}

export function errorHandler(error: ApiError, req: Request, res: Response, next: NextFunction) {
  const statusCode = error.statusCode || 500
  const response = {
    success: false,
    error: error.message,
    code: error.code,
    details: error.details,
    timestamp: new Date().toISOString()
  }
  
  // 记录错误日志
  console.error(`[${statusCode}] ${req.method} ${req.path}:`, error)
  
  res.status(statusCode).json(response)
}
```

---

## 📋 Day 2-3: 实现 /api/validate 端点

### 任务 2.1: 创建验证路由

**创建文件: `packages/api-nova-server/src/api/routes/validate.ts`**
```typescript
import { Router } from 'express'
import { z } from 'zod'
import SwaggerParser from 'swagger-parser'
import { createError } from '../middleware/error'

const router = Router()

// 请求验证 Schema
const validateRequestSchema = z.object({
  source: z.object({
    type: z.enum(['url', 'file', 'text']),
    content: z.string().min(1, '内容不能为空'),
    auth: z.object({
      type: z.enum(['bearer', 'apikey', 'basic']),
      token: z.string()
    }).optional()
  })
})

router.post('/', async (req, res, next) => {
  try {
    // 验证请求数据
    const { source } = validateRequestSchema.parse(req.body)
    
    let openApiSpec: any
    
    // 根据输入类型处理
    switch (source.type) {
      case 'url':
        openApiSpec = await SwaggerParser.validate(source.content)
        break
      case 'text':
        try {
          const parsed = JSON.parse(source.content)
          openApiSpec = await SwaggerParser.validate(parsed)
        } catch (parseError) {
          throw createError('无效的 JSON 格式', 400, 'INVALID_JSON')
        }
        break
      case 'file':
        // 文件内容已经在前端读取为文本
        try {
          const parsed = JSON.parse(source.content)
          openApiSpec = await SwaggerParser.validate(parsed)
        } catch (parseError) {
          throw createError('无效的文件格式', 400, 'INVALID_FILE')
        }
        break
    }
    
    // 返回验证结果
    res.json({
      success: true,
      data: {
        valid: true,
        version: openApiSpec.openapi || openApiSpec.swagger,
        title: openApiSpec.info?.title,
        paths: Object.keys(openApiSpec.paths || {}).length
      },
      message: '验证成功'
    })
    
  } catch (error: any) {
    if (error.name === 'ZodError') {
      next(createError('请求参数错误', 400, 'VALIDATION_ERROR', error.errors))
    } else if (error.statusCode) {
      next(error)
    } else {
      next(createError('OpenAPI 规范验证失败: ' + error.message, 400, 'OPENAPI_VALIDATION_ERROR'))
    }
  }
})

export { router as validateRoute }
```

---

## 📋 Day 3-4: 实现 /api/preview 端点

### 任务 3.1: 创建预览路由

**创建文件: `packages/api-nova-server/src/api/routes/preview.ts`**
```typescript
import { Router } from 'express'
import { z } from 'zod'
import SwaggerParser from 'swagger-parser'
import { createError } from '../middleware/error'
import { parseOpenApiSpec } from '../../utils/openapi-parser'

const router = Router()

const previewRequestSchema = z.object({
  source: z.object({
    type: z.enum(['url', 'file', 'text']),
    content: z.string().min(1),
    auth: z.object({
      type: z.enum(['bearer', 'apikey', 'basic']),
      token: z.string()
    }).optional()
  })
})

router.post('/', async (req, res, next) => {
  try {
    const { source } = previewRequestSchema.parse(req.body)
    
    let openApiSpec: any
    
    // 解析 OpenAPI 规范
    switch (source.type) {
      case 'url':
        openApiSpec = await SwaggerParser.dereference(source.content)
        break
      case 'text':
      case 'file':
        const parsed = JSON.parse(source.content)
        openApiSpec = await SwaggerParser.dereference(parsed)
        break
    }
    
    // 提取 API 信息
    const apiInfo = {
      title: openApiSpec.info?.title || 'Untitled API',
      version: openApiSpec.info?.version || '1.0.0',
      description: openApiSpec.info?.description,
      serverUrl: openApiSpec.servers?.[0]?.url || '',
      totalEndpoints: 0
    }
    
    // 提取端点信息
    const endpoints: any[] = []
    
    if (openApiSpec.paths) {
      for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
        const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
        
        for (const method of methods) {
          const operation = (pathItem as any)[method]
          if (operation) {
            endpoints.push({
              method: method.toUpperCase(),
              path,
              summary: operation.summary,
              description: operation.description,
              tags: operation.tags || [],
              operationId: operation.operationId,
              deprecated: operation.deprecated || false
            })
          }
        }
      }
    }
    
    apiInfo.totalEndpoints = endpoints.length
    
    res.json({
      success: true,
      data: {
        apiInfo,
        endpoints
      },
      message: '预览成功'
    })
    
  } catch (error: any) {
    if (error.name === 'ZodError') {
      next(createError('请求参数错误', 400, 'VALIDATION_ERROR', error.errors))
    } else {
      next(createError('预览失败: ' + error.message, 400, 'PREVIEW_ERROR'))
    }
  }
})

export { router as previewRoute }
```

---

## 📋 Day 4-5: 实现 /api/convert 端点

### 任务 4.1: 创建转换路由

**创建文件: `packages/api-nova-server/src/api/routes/convert.ts`**
```typescript
import { Router } from 'express'
import { z } from 'zod'
import SwaggerParser from 'swagger-parser'
import { createError } from '../middleware/error'
import { transformOpenApiToMcp } from '../../transform/openapi-to-mcp-converter'

const router = Router()

const convertRequestSchema = z.object({
  source: z.object({
    type: z.enum(['url', 'file', 'text']),
    content: z.string().min(1),
    auth: z.object({
      type: z.enum(['bearer', 'apikey', 'basic']),
      token: z.string()
    }).optional()
  }),
  config: z.object({
    filters: z.object({
      methods: z.array(z.string()),
      tags: z.array(z.string()),
      includeDeprecated: z.boolean()
    }),
    transport: z.enum(['stdio', 'sse', 'streamable']),
    optimization: z.object({
      generateValidation: z.boolean(),
      includeExamples: z.boolean(),
      optimizeNames: z.boolean()
    })
  })
})

router.post('/', async (req, res, next) => {
  try {
    const startTime = Date.now()
    const { source, config } = convertRequestSchema.parse(req.body)
    
    // 解析 OpenAPI 规范
    let openApiSpec: any
    switch (source.type) {
      case 'url':
        openApiSpec = await SwaggerParser.dereference(source.content)
        break
      case 'text':
      case 'file':
        const parsed = JSON.parse(source.content)
        openApiSpec = await SwaggerParser.dereference(parsed)
        break
    }
    
    // 转换为 MCP 格式
    const mcpResult = await transformOpenApiToMcp(openApiSpec, config)
    
    const processingTime = Date.now() - startTime
    
    res.json({
      success: true,
      data: {
        mcpConfig: mcpResult.mcpConfig,
        metadata: mcpResult.metadata,
        processingTime
      },
      message: '转换成功'
    })
    
  } catch (error: any) {
    if (error.name === 'ZodError') {
      next(createError('请求参数错误', 400, 'VALIDATION_ERROR', error.errors))
    } else {
      next(createError('转换失败: ' + error.message, 400, 'CONVERT_ERROR'))
    }
  }
})

export { router as convertRoute }
```

### 任务 4.2: 创建基础转换逻辑

**创建文件: `packages/api-nova-server/src/transform/openapi-to-mcp-converter.ts`**
```typescript
export interface ConvertConfig {
  filters: {
    methods: string[]
    tags: string[]
    includeDeprecated: boolean
  }
  transport: 'stdio' | 'sse' | 'streamable'
  optimization: {
    generateValidation: boolean
    includeExamples: boolean
    optimizeNames: boolean
  }
}

export async function transformOpenApiToMcp(openApiSpec: any, config: ConvertConfig) {
  // 提取 API 信息
  const apiInfo = {
    title: openApiSpec.info?.title || 'Untitled API',
    version: openApiSpec.info?.version || '1.0.0',
    description: openApiSpec.info?.description,
    serverUrl: openApiSpec.servers?.[0]?.url || ''
  }
  
  // 提取并过滤端点
  const endpoints = extractEndpoints(openApiSpec)
  const filteredEndpoints = filterEndpoints(endpoints, config.filters)
  
  // 生成 MCP 工具
  const tools = generateMcpTools(filteredEndpoints, config.optimization)
  
  // 生成 MCP 配置
  const mcpConfig = {
    mcpServers: {
      [toKebabCase(apiInfo.title)]: {
        command: "node",
        args: ["dist/index.js", "--transport", config.transport],
        env: {
          API_BASE_URL: apiInfo.serverUrl
        }
      }
    },
    tools
  }
  
  return {
    mcpConfig,
    metadata: {
      apiInfo,
      stats: {
        totalEndpoints: endpoints.length,
        convertedTools: tools.length,
        skippedEndpoints: endpoints.length - filteredEndpoints.length
      }
    }
  }
}

function extractEndpoints(openApiSpec: any) {
  const endpoints: any[] = []
  
  if (openApiSpec.paths) {
    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      const methods = ['get', 'post', 'put', 'delete', 'patch']
      
      for (const method of methods) {
        const operation = (pathItem as any)[method]
        if (operation) {
          endpoints.push({
            method: method.toUpperCase(),
            path,
            summary: operation.summary,
            description: operation.description,
            tags: operation.tags || [],
            operationId: operation.operationId,
            deprecated: operation.deprecated || false,
            parameters: operation.parameters || [],
            requestBody: operation.requestBody,
            responses: operation.responses
          })
        }
      }
    }
  }
  
  return endpoints
}

function filterEndpoints(endpoints: any[], filters: ConvertConfig['filters']) {
  return endpoints.filter(endpoint => {
    // 方法过滤
    if (!filters.methods.includes(endpoint.method)) {
      return false
    }
    
    // 标签过滤
    if (filters.tags.length > 0) {
      const hasMatchingTag = endpoint.tags.some((tag: string) => 
        filters.tags.includes(tag)
      )
      if (!hasMatchingTag) return false
    }
    
    // 废弃端点过滤
    if (!filters.includeDeprecated && endpoint.deprecated) {
      return false
    }
    
    return true
  })
}

function generateMcpTools(endpoints: any[], optimization: ConvertConfig['optimization']) {
  return endpoints.map(endpoint => {
    const toolName = optimization.optimizeNames 
      ? generateOptimizedToolName(endpoint)
      : `${endpoint.method.toLowerCase()}_${endpoint.path.replace(/[^a-zA-Z0-9]/g, '_')}`
    
    return {
      name: toolName,
      description: endpoint.summary || endpoint.description || `${endpoint.method} ${endpoint.path}`,
      inputSchema: generateInputSchema(endpoint, optimization)
    }
  })
}

function generateOptimizedToolName(endpoint: any): string {
  // 简化工具名称生成逻辑
  const method = endpoint.method.toLowerCase()
  const pathParts = endpoint.path.split('/').filter(Boolean)
  const lastPart = pathParts[pathParts.length - 1]
  
  return `${method}_${lastPart.replace(/[^a-zA-Z0-9]/g, '_')}`
}

function generateInputSchema(endpoint: any, optimization: ConvertConfig['optimization']) {
  // 基础 schema 生成
  const schema: any = {
    type: "object",
    properties: {}
  }
  
  // 处理路径参数
  const pathParams = endpoint.parameters?.filter((p: any) => p.in === 'path') || []
  pathParams.forEach((param: any) => {
    schema.properties[param.name] = {
      type: param.schema?.type || 'string',
      description: param.description
    }
  })
  
  // 处理查询参数
  const queryParams = endpoint.parameters?.filter((p: any) => p.in === 'query') || []
  queryParams.forEach((param: any) => {
    schema.properties[param.name] = {
      type: param.schema?.type || 'string',
      description: param.description
    }
  })
  
  return schema
}

function toKebabCase(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}
```

---

## 📋 Day 5-7: 集成和测试

### 任务 5.1: 修改服务器启动脚本

**修改文件: `packages/api-nova-server/src/index.ts`**
```typescript
import { Command } from 'commander'
import { runStdioServer, runSseServer, runStreamableServer } from './server'
import { startHttpServer } from './api/server'

const program = new Command()

program
  .name('api-nova-server')
  .description('ApiNova Server - Transform OpenAPI specs to MCP format')
  .version('1.0.0')

program
  .command('stdio')
  .description('Start MCP server with stdio transport')
  .action(async () => {
    await runStdioServer()
  })

program
  .command('sse')
  .description('Start MCP server with SSE transport')
  .option('-p, --port <port>', 'Port to listen on', '3322')
  .action(async (options) => {
    await runSseServer('/sse', parseInt(options.port))
  })

program
  .command('http')
  .description('Start HTTP API server')
  .option('-p, --port <port>', 'Port to listen on', '3322')
  .action(async (options) => {
    startHttpServer(parseInt(options.port))
  })

program
  .command('dev')
  .description('Start development server (HTTP API + SSE)')
  .option('-p, --port <port>', 'Port to listen on', '3322')
  .action(async (options) => {
    const port = parseInt(options.port)
    
    // 启动 HTTP API 服务器
    startHttpServer(port)
    
    // 同时启动 SSE MCP 服务器在不同端口
    setTimeout(() => {
      runSseServer('/sse', port + 1)
    }, 1000)
  })

program.parse()
```

### 任务 5.2: 更新 package.json 脚本

**修改文件: `packages/api-nova-server/package.json`**
```json
{
  "scripts": {
    "dev": "nodemon --exec \"npm run build && node dist/index.js dev\"",
    "dev:http": "nodemon --exec \"npm run build && node dist/index.js http\"",
    "dev:stdio": "nodemon --exec \"npm run build && node dist/index.js stdio\"",
    "start": "node dist/index.js",
    "start:http": "node dist/index.js http",
    "build": "tsc",
    "test": "jest"
  }
}
```

### 任务 5.3: 前端禁用演示模式

**修改文件: `packages/api-nova-ui/.env.development`**
```bash
# 开发环境配置
VITE_APP_TITLE=ApiNova Server
VITE_API_BASE_URL=http://localhost:9022
VITE_ENABLE_DEMO_MODE=false
```

### 任务 5.4: 测试端到端功能

**测试清单:**
- [ ] 启动后端服务器: `npm run dev:http`
- [ ] 启动前端服务器: `npm run dev`  
- [ ] 测试 URL 输入和验证
- [ ] 测试文件上传和预览
- [ ] 测试文本输入和转换
- [ ] 检查错误处理和用户反馈

---

## 🔧 开发环境准备

### 必要的工具和扩展
```bash
# VS Code 扩展
- Thunder Client (API 测试)
- REST Client (API 测试备选)
- Error Lens (错误提示)
- ES7+ React/Redux/React-Native snippets

# Chrome 扩展  
- Vue.js devtools
- JSON Formatter
```

### 调试配置

**创建文件: `.vscode/launch.json`**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Backend",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/packages/api-nova-server/dist/index.js",
      "args": ["http"],
      "outFiles": ["${workspaceFolder}/packages/api-nova-server/dist/**/*.js"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

---

## ✅ 每日检查清单

### Day 1 完成标志
- [ ] Express 服务器可以启动
- [ ] CORS 配置正确
- [ ] 健康检查端点响应正常

### Day 2 完成标志  
- [ ] `/api/validate` 端点可以验证 URL
- [ ] 错误处理正常工作
- [ ] 请求参数验证有效

### Day 3 完成标志
- [ ] `/api/preview` 端点返回 API 信息
- [ ] 端点列表提取正确
- [ ] 前端可以显示预览数据

### Day 4 完成标志
- [ ] `/api/convert` 端点生成 MCP 配置
- [ ] 基础转换逻辑工作正常
- [ ] 配置过滤功能有效

### Day 5-7 完成标志
- [ ] 前后端完全集成
- [ ] 所有功能端到端测试通过
- [ ] 错误处理用户友好
- [ ] 性能满足基本要求

---

## 🆘 问题和解决方案

### 常见问题
1. **CORS 错误**: 检查 cors 配置和前端 baseURL
2. **TypeScript 编译错误**: 确保所有依赖类型正确安装  
3. **JSON 解析错误**: 添加更好的错误处理和用户提示
4. **内存问题**: 大文件处理时注意内存限制

### 调试技巧
- 使用 `console.log` 追踪数据流
- Thunder Client 测试 API 端点
- Chrome DevTools 检查网络请求
- Vue DevTools 检查状态变化

这个任务清单可以让您立即开始第一周的开发工作，每个任务都有明确的目标和可验证的完成标志。建议按顺序执行，确保每个步骤都完成后再进行下一步。
