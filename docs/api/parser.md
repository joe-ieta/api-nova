---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# Parser开发API手册

公共入口为`api-nova-parser`，以[导出源码](../../packages/api-nova-parser/src/index.ts)和生成的dist声明为准。Parser负责规范解析、校验、归一化和工具转换，管理资产及发布授权仍由API负责。

## 最小例子

在仓库完成根安装与构建后，可从调用工作区使用：

```javascript
const { parseFromFile, parseFromString, parseAndTransform } = require('api-nova-parser');

async function main() {
  const parsed = await parseFromFile('./examples/minimal-openapi.json');
  console.log(parsed.spec.info.title);
  const fromText = await parseFromString(JSON.stringify(parsed.spec));
  const tools = await parseAndTransform(JSON.stringify(fromText.spec), { isString: true });
  console.log(tools.length);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
```

文件路径由调用者工作目录决定；不要把包的安装位置当作配置根。对外安装应使用已核实的包版本，产品Git标签和npm workspace版本不同。

## 主要导出

| 接口 | 参数 | 返回/作用 |
| --- | --- | --- |
| parseFromFile | filePath, 可选ParserConfig | Promise解析结果；规范在result.spec中 |
| parseFromUrl | url, 可选ParserConfig | 读取URL并执行相同处理；网络、超时与安全策略依有效配置 |
| parseFromString | content, 可选ParserConfig | JSON/YAML文本处理 |
| new OpenAPIParser | 可选ParserConfig | 实例方法支持parseFromUrl/File/String及validate；方法特定选项见类型声明 |
| parseAndTransform | source, options | Promise工具数组；isString/isUrl、parserConfig、transformerOptions |
| transformToMCPTools | spec, 可选TransformerOptions | 按已解析规范生成工具；具体返回类型见导出声明 |
| OpenAPIToMCPTransformer | 转换器类 | 高级转换入口，沿用同一核心实现 |

ParseResult、ParserConfig、OpenAPISpec、ValidationResult、MCPTool等类型从公共入口导出。鉴权、header和审计辅助类型也有导出，但导出OAuth2Config不表示已实现token获取流程。不要使用旧技术文档中尚未核实的插件、缓存、worker或性能保证。

## 行为与错误

Swagger2兼容转换、版本检测、校验和引用处理走共享实现；复杂规范是否支持取决于当前校验/转换结果，不能把兼容处理写成接受所有任意版本。处理错误由调用方捕获，错误详情按受控方式记录，避免把带凭据URL、原始秘密或整个规范写入日志。

调用工具的执行handler需要有效base URL及上游认证/网络上下文；生成工具不是启动MCP Server，也不自动注册为API运行资产。二进制、取消、超时、重定向和审计语义按现有执行合同，不在外部应用中另造第二套解析逻辑。

## 修改与验证

Parser变更先构建，再按[传播验证指南](../guides/parser-change-verification.md)验证Server/API消费链。本文最小例子在文档整理时使用仓库examples实际执行；完整测试数量和发布证明仅引用对应日期证据，不固化为永久性能承诺。
