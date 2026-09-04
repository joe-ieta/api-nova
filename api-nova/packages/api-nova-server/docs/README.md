# ApiNova 架构重构方案

## 🎯 项目概述

ApiNova 架构重构项目旨在将现有的单体MCP服务器演进为一个灵活、可复用、生产级的工具库，同时保持100%的向下兼容性。

### 核心价值
- **向下兼容**: 现有代码零修改即可运行
- **向上扩展**: 提供强大的工具库和集成能力
- **生产就绪**: 支持监控、安全、高并发等企业级需求
- **灵活集成**: 支持独立运行、Web框架集成、纯库调用等多种方式

## 🏗️ 架构设计

### 分层架构
```
┌─────────────────────────────────────────────────────────────┐
│                    Applications Layer                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐ │
│  │  Standalone CLI │  │   NestJS API    │  │  Other Apps   │ │
│  └─────────────────┘  └─────────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                   Adapters Layer                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐ │
│  │   CLI Adapter   │  │  HTTP Adapter   │  │ Library...    │ │
│  └─────────────────┘  └─────────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                      Core Library                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐ │
│  │  Tool Manager   │  │  MCP Registry   │  │  Transformer  │ │
│  └─────────────────┘  └─────────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                  Compatibility Layer                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐ │
│  │   server.ts     │  │  initTools.ts   │  │  transform.ts │ │
│  └─────────────────┘  └─────────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 核心组件

#### 1. 工具管理器 (ToolManager)
- 动态工具注册/注销
- 工具验证和规范化
- 事件驱动的工具生命周期管理
- 内存高效的工具存储和索引

#### 2. MCP注册中心 (MCPRegistry)
- 多MCP服务器实例管理
- 工具到服务器的动态绑定
- 健康检查和状态监控
- 优雅关闭和资源清理

#### 3. 转换器 (Transformer)
- OpenAPI规范解析和转换
- 支持文件、URL、内存对象输入
- 工具验证和规范化
- 灵活的过滤和定制选项

## 🚀 使用方式

### 方式1: 独立使用 (完全兼容现有方式)
```typescript
// 现有代码无需任何修改
import { runStdioServer } from 'api-nova-server';

runStdioServer();
```

### 方式2: NestJS框架集成
```typescript
import { Injectable } from '@nestjs/common';
import { HTTPAdapter } from 'api-nova-server';

@Injectable()
export class McpService {
  private httpAdapter = new HTTPAdapter();
  
  async registerOpenAPITools(filePath: string) {
    const serverId = await this.httpAdapter.createManagedServer({
      name: 'my-api-server'
    });
    
    await this.httpAdapter.registerToolsFromOpenAPI(serverId, filePath);
    return this.httpAdapter.getServerHandler(serverId);
  }
}
```

### 方式3: 纯库形式集成
```typescript
import { createToolchain } from 'api-nova-server';

const { toolManager, transformer } = createToolchain();

// 动态加载工具
const tools = await transformer.transformFromUrl('https://api.example.com/swagger.json');
await toolManager.registerTools(tools);

// 监听工具变化
toolManager.on('toolRegistered', (event) => {
  console.log(`New tool: ${event.tool.name}`);
});
```

### 方式4: 高级自定义
```typescript
import { AdapterFactory, ToolManager, MCPRegistry } from 'api-nova-server';

// 创建自定义适配器
const adapter = AdapterFactory.createHTTP({
  enableMetrics: true,
  enableHealthCheck: true
});

// 动态管理多个API服务
const apiServerId = await adapter.createManagedServer({ name: 'api-v1' });
const adminServerId = await adapter.createManagedServer({ name: 'admin' });

// 分别注册不同的工具集
await adapter.registerToolsFromUrl(apiServerId, 'https://api.example.com/swagger.json');
await adapter.registerToolsFromUrl(adminServerId, 'https://admin.example.com/swagger.json');
```

## 💡 核心特性

### 🔄 动态工具管理
- **运行时注册**: 无需重启即可添加新工具
- **热重载**: 支持OpenAPI规范变更的自动更新
- **智能缓存**: 高效的工具存储和查找机制
- **事件驱动**: 实时的工具状态变化通知

### 🌐 多协议支持
- **STDIO**: 命令行接口集成
- **HTTP Stream**: Web应用集成
- **SSE**: 服务器推送事件
- **WebSocket**: 实时双向通信(规划中)

### 📊 监控和观测
- **健康检查**: `/health` 端点提供系统状态
- **指标收集**: `/metrics` 端点暴露性能数据
- **结构化日志**: 便于问题诊断和性能分析
- **分布式追踪**: 支持APM工具集成

### 🔐 安全和认证
- **JWT认证**: 标准的令牌认证机制
- **API密钥**: 简单的密钥认证
- **请求限流**: 防止API滥用
- **CORS支持**: 跨域请求控制

### ⚡ 性能优化
- **内存高效**: 优化的数据结构和算法
- **并发处理**: 支持高并发工具调用
- **懒加载**: 按需加载OpenAPI规范
- **缓存机制**: 智能缓存减少重复计算

## 🔧 技术架构

### 类型系统
```typescript
interface MCPTool {
  id: string;
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => Promise<any>;
  metadata?: {
    tags?: string[];
    deprecated?: boolean;
    version?: string;
  };
}

interface ToolManager {
  registerTool(tool: MCPTool): Promise<void>;
  unregisterTool(toolId: string): Promise<void>;
  getTool(toolId: string): MCPTool | undefined;
  getTools(): MCPTool[];
  on(event: string, handler: Function): void;
}
```

### 事件系统
```typescript
// 监听工具注册事件
toolManager.on('toolRegistered', (event) => {
  console.log(`Tool registered: ${event.tool.name}`);
  // 自动通知相关服务
  notifyServices(event.tool);
});

// 监听工具执行事件
toolManager.on('toolExecuted', (event) => {
  // 记录执行统计
  metrics.increment('tool.executions', {
    tool: event.tool.name,
    status: event.success ? 'success' : 'error'
  });
});
```

### 中间件系统
```typescript
// 认证中间件
const authMiddleware = httpAdapter.createAuthMiddleware(async (token) => {
  return await validateJwtToken(token);
});

// 限流中间件
const rateLimitMiddleware = httpAdapter.createRateLimitMiddleware(100, 60000);

// 应用中间件
app.use('/mcp', authMiddleware, rateLimitMiddleware, mcpHandler);
```

## 📁 项目结构

```
packages/api-nova-server/
├── src/
│   ├── core/                    # 核心工具库
│   │   ├── ToolManager.ts       # 工具管理器
│   │   ├── MCPRegistry.ts       # MCP注册中心
│   │   ├── Transformer.ts       # 转换器
│   │   └── index.ts
│   │
│   ├── adapters/               # 适配器层
│   │   ├── CLIAdapter.ts       # CLI适配器
│   │   ├── HTTPAdapter.ts      # HTTP适配器
│   │   ├── LibraryAdapter.ts   # 库适配器
│   │   └── AdapterFactory.ts   # 适配器工厂
│   │
│   ├── lib/                   # 兼容层
│   │   ├── server.ts          # 原server.ts兼容
│   │   ├── initTools.ts       # 原initTools.ts兼容
│   │   └── index.ts          # 兼容API导出
│   │
│   ├── transport/             # 传输层
│   │   ├── stdio.ts          # STDIO传输
│   │   ├── sse.ts            # SSE传输
│   │   └── streamable.ts     # HTTP Stream传输
│   │
│   ├── types/                # 类型定义
│   │   ├── core.ts           # 核心类型
│   │   └── adapters.ts       # 适配器类型
│   │
│   └── index.ts             # 主入口
│
├── examples/                 # 使用示例
│   ├── standalone-cli.ts     # 独立CLI示例
│   ├── nestjs-integration.ts # NestJS集成示例
│   └── dynamic-tools.ts      # 动态工具示例
│
└── docs/                    # 详细文档
    ├── architecture-refactoring-comprehensive-plan.md
    ├── core-implementation-guide.md
    ├── adapter-implementation-guide.md
    ├── compatibility-layer-implementation.md
    └── implementation-roadmap.md
```

## 🎭 兼容性策略

### 无缝升级路径
```typescript
// Level 0: 继续使用现有API (零修改)
import { runStdioServer } from 'api-nova-server';
runStdioServer();

// Level 1: 使用新的核心API (渐进式)
import { createToolchain } from 'api-nova-server';
const toolchain = createToolchain();

// Level 2: 使用适配器模式 (现代化)
import { AdapterFactory } from 'api-nova-server';
const adapter = AdapterFactory.createCLI();

// Level 3: 完全自定义架构 (最大灵活性)
import { ToolManager, MCPRegistry, Transformer } from 'api-nova-server';
const toolManager = new ToolManager();
```

### 迁移保证
- ✅ **API兼容**: 所有现有API保持不变
- ✅ **行为兼容**: 输出格式、日志样式一致
- ✅ **性能兼容**: 性能不低于现有版本
- ✅ **配置兼容**: 所有配置参数继续有效

## 🛣️ 实施计划

### Phase 1: 核心架构 (Week 1-2)
- 实现ToolManager、MCPRegistry、Transformer
- 建立完整的类型系统
- 重构传输层

### Phase 2: 适配器层 (Week 3-4)
- 实现CLI、HTTP、Library适配器
- 添加监控和安全功能
- 创建适配器工厂

### Phase 3: 兼容层 (Week 4-5)
- 实现完整的向下兼容包装
- 全面的回归测试
- 性能基准测试

### Phase 4: 高级功能 (Week 5-6)
- 动态工具管理
- 监控和观测能力
- 安全和认证机制

### Phase 5: 文档和发布 (Week 6-7)
- 完整的API文档
- 迁移指南和示例
- 发布和CI/CD

## 📈 预期收益

### 对现有用户
- **零升级成本**: 无需修改现有代码
- **性能提升**: 更高效的架构实现
- **更好的稳定性**: 生产级的错误处理和监控

### 对新用户
- **灵活的集成方式**: 支持多种使用场景
- **强大的功能**: 动态管理、监控、安全等
- **现代化的开发体验**: TypeScript、事件驱动、中间件

### 对开发团队
- **代码质量提升**: 清晰的分层架构
- **维护性改善**: 单一职责和依赖倒置
- **扩展性增强**: 易于添加新功能和适配器

## 🤝 贡献指南

这个重构方案是一个开放的技术架构设计，欢迎：
- 🐛 报告问题和建议
- 💡 提出新的功能想法
- 🔧 贡献代码实现
- 📚 改进文档和示例

## 📞 技术支持

如需技术讨论和实施支持，请参考：
- 📖 详细文档: `/docs` 目录下的各种技术文档
- 💻 示例代码: `/examples` 目录下的实际用例
- 🧪 测试用例: `/test` 目录下的完整测试套件

---

**这是一个既保持向下兼容又面向未来的现代化架构重构方案，实现了"无痛升级，强大扩展"的设计目标。**
