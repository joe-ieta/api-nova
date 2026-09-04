# ApiNova Server Monorepo 架构提案

## 🏗️ 推荐的 Monorepo 结构

```
api-nova-server/
├── packages/
│   ├── api-nova-parser/          # 🔍 核心解析库
│   │   ├── src/
│   │   │   ├── parsers/
│   │   │   │   ├── openapi-parser.ts      # OpenAPI 3.x 解析器
│   │   │   │   ├── swagger-parser.ts      # Swagger 2.0 解析器
│   │   │   │   ├── postman-parser.ts      # Postman Collection 解析器
│   │   │   │   └── index.ts
│   │   │   ├── validators/
│   │   │   │   ├── schema-validator.ts    # 规范验证
│   │   │   │   ├── security-validator.ts  # 安全配置验证
│   │   │   │   └── index.ts
│   │   │   ├── normalizers/
│   │   │   │   ├── path-normalizer.ts     # 路径标准化
│   │   │   │   ├── schema-normalizer.ts   # Schema 标准化
│   │   │   │   └── index.ts
│   │   │   ├── types/
│   │   │   │   ├── openapi.ts            # OpenAPI 类型定义
│   │   │   │   ├── parser.ts             # 解析器接口
│   │   │   │   └── index.ts
│   │   │   └── index.ts                  # 主入口
│   │   ├── tests/
│   │   ├── package.json
│   │   └── README.md
│   │
│   ├── api-nova-converter/       # 🔄 转换逻辑库
│   │   ├── src/
│   │   │   ├── converters/
│   │   │   │   ├── openapi-to-mcp.ts     # OpenAPI → MCP 转换
│   │   │   │   ├── postman-to-mcp.ts     # Postman → MCP 转换
│   │   │   │   └── index.ts
│   │   │   ├── strategies/
│   │   │   │   ├── rest-strategy.ts      # REST API 转换策略
│   │   │   │   ├── graphql-strategy.ts   # GraphQL 转换策略
│   │   │   │   └── index.ts
│   │   │   ├── optimizers/
│   │   │   │   ├── tool-optimizer.ts     # MCP 工具优化
│   │   │   │   ├── schema-optimizer.ts   # Schema 优化
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   └── README.md
│   │
│   ├── api-nova-server/          # ⚙️ MCP 协议服务器
│   │   ├── src/
│   │   │   ├── server.ts            # MCP 服务器核心
│   │   │   ├── transports/          # 传输层
│   │   │   ├── tools/               # MCP 工具实现
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── README.md
│   │
│   ├── api-nova-ui/              # 🎨 Web 用户界面
│   │   ├── src/
│   │   ├── package.json
│   │   └── README.md
│   │
│   ├── api-nova-cli/             # 💻 命令行工具 (新增)
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── convert.ts       # 转换命令
│   │   │   │   ├── validate.ts      # 验证命令
│   │   │   │   └── index.ts
│   │   │   ├── cli.ts               # CLI 入口
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── README.md
│   │
│   └── api-nova-types/           # 📋 共享类型定义
│       ├── src/
│       │   ├── openapi.ts           # OpenAPI 类型
│       │   ├── mcp.ts               # MCP 类型
│       │   ├── config.ts            # 配置类型
│       │   └── index.ts
│       ├── package.json
│       └── README.md
│
├── apps/                            # 🚀 应用示例
│   ├── playground/                  # 在线演示
│   └── examples/                    # 使用示例
│
├── tools/                           # 🔧 开发工具
│   ├── build/                       # 构建脚本
│   ├── testing/                     # 测试工具
│   └── linting/                     # 代码检查
│
├── docs/                            # 📚 文档
├── package.json                     # 根 package.json
├── pnpm-workspace.yaml             # PNPM 工作空间配置
└── README.md
```

## 🎯 核心包职责分工

### 📦 api-nova-parser
**职责**: 专注于 API 规范的解析和标准化
```typescript
// 主要 API 设计
export class OpenApiParser {
  async parseFromUrl(url: string, options?: ParseOptions): Promise<ParsedApi>
  async parseFromFile(filepath: string, options?: ParseOptions): Promise<ParsedApi>
  async parseFromText(content: string, format: 'json' | 'yaml', options?: ParseOptions): Promise<ParsedApi>
  
  validate(spec: any): ValidationResult
  normalize(spec: ParsedApi): NormalizedApi
}

export interface ParsedApi {
  version: '2.0' | '3.0' | '3.1'
  info: ApiInfo
  paths: ApiPath[]
  components: ApiComponents
  security: SecurityScheme[]
}
```

### 🔄 api-nova-converter
**职责**: 专注于格式转换逻辑
```typescript
// 主要 API 设计
export class McpConverter {
  constructor(private options: ConvertOptions) {}
  
  async convertFromParsedApi(api: ParsedApi): Promise<McpConfig>
  async convertFromOpenApi(spec: OpenApiSpec): Promise<McpConfig>
  
  setStrategy(strategy: ConversionStrategy): void
  addOptimizer(optimizer: Optimizer): void
}

export interface ConvertOptions {
  filters: FilterConfig
  optimization: OptimizationConfig
  transport: TransportConfig
}
```

### ⚙️ api-nova-server
**职责**: 专注于 MCP 协议实现
```typescript
// 主要 API 设计
export class McpSwaggerServer {
  constructor(private config: ServerConfig) {}
  
  async start(): Promise<void>
  async stop(): Promise<void>
  
  addTool(tool: McpTool): void
  setTransport(transport: Transport): void
}
```

## 📊 依赖关系图

```
api-nova-types ← (所有包都依赖)
       ↑
api-nova-parser ← api-nova-converter ← api-nova-server
                                          ← api-nova-cli
                                          ← api-nova-ui
```

## 🚀 迁移计划

### 阶段 1: 创建核心解析库 (1-2 天)
- [ ] 创建 `api-nova-parser` 包
- [ ] 抽离现有的 OpenAPI 解析逻辑
- [ ] 添加完整的类型定义
- [ ] 编写单元测试

### 阶段 2: 创建转换库 (2-3 天)
- [ ] 创建 `api-nova-converter` 包
- [ ] 抽离转换逻辑
- [ ] 实现策略模式
- [ ] 添加优化器支持

### 阶段 3: 重构现有服务器 (1-2 天)
- [ ] 更新 `api-nova-server` 使用新的库
- [ ] 更新 `api-nova-ui` 使用新的库
- [ ] 更新依赖关系

### 阶段 4: 增强和扩展 (按需)
- [ ] 创建 CLI 工具
- [ ] 添加更多解析器支持
- [ ] 性能优化

## 💡 额外优势

### 1. **生态系统扩展**
```typescript
// 其他开发者可以轻松扩展
import { BaseParser } from 'api-nova-parser';

class CustomApiParser extends BaseParser {
  // 自定义解析逻辑
}
```

### 2. **插件系统**
```typescript
// 支持插件扩展
const converter = new McpConverter()
  .use(new ValidationPlugin())
  .use(new OptimizationPlugin())
  .use(new CustomTransformPlugin());
```

### 3. **多环境支持**
```typescript
// Node.js 环境
import { OpenApiParser } from 'api-nova-parser/node';

// 浏览器环境
import { OpenApiParser } from 'api-nova-parser/browser';

// Deno 环境
import { OpenApiParser } from 'api-nova-parser/deno';
```

## 🎯 结论

**强烈推荐** 进行这次重构！这不仅会让代码更加模块化和可维护，还为未来的扩展奠定了坚实的基础。这种架构设计体现了现代软件开发的最佳实践。
