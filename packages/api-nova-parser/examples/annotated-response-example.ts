/**
 * 使用示例：带有中文字段注释的 Swagger API 转换为 MCP 工具
 */

import { parseFromString, transformToMCPTools } from 'api-nova-parser';

// 示例：包含中文注释的 Swagger 规范
const swaggerSpecWithChineseComments = {
  "openapi": "3.0.0",
  "info": {
    "title": "用户管理 API",
    "version": "1.0.0",
    "description": "用户管理系统的 RESTful API"
  },
  "servers": [
    {
      "url": "https://api.example.com/v1"
    }
  ],
  "paths": {
    "/users": {
      "get": {
        "summary": "获取用户列表",
        "description": "获取系统中所有用户的信息",
        "operationId": "getUsers",
        "responses": {
          "200": {
            "description": "成功获取用户列表",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "code": {
                      "type": "integer",
                      "description": "响应状态码",
                      "example": 200
                    },
                    "message": {
                      "type": "string",
                      "description": "响应消息",
                      "example": "操作成功"
                    },
                    "data": {
                      "type": "object",
                      "description": "响应数据",
                      "properties": {
                        "users": {
                          "type": "array",
                          "description": "用户列表",
                          "items": {
                            "$ref": "#/components/schemas/User"
                          }
                        },
                        "total": {
                          "type": "integer",
                          "description": "用户总数",
                          "example": 100
                        },
                        "pageSize": {
                          "type": "integer",
                          "description": "每页显示数量",
                          "example": 20
                        },
                        "currentPage": {
                          "type": "integer",
                          "description": "当前页码",
                          "example": 1
                        }
                      },
                      "required": ["users", "total"]
                    }
                  },
                  "required": ["code", "message", "data"]
                }
              }
            }
          }
        }
      }
    },
    "/users/{userId}": {
      "get": {
        "summary": "获取用户详情",
        "description": "根据用户ID获取特定用户的详细信息",
        "operationId": "getUserById",
        "parameters": [
          {
            "name": "userId",
            "in": "path",
            "required": true,
            "description": "用户唯一标识符",
            "schema": {
              "type": "integer",
              "example": 123
            }
          }
        ],
        "responses": {
          "200": {
            "description": "成功获取用户信息",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "code": {
                      "type": "integer",
                      "description": "响应状态码"
                    },
                    "message": {
                      "type": "string",
                      "description": "响应消息"
                    },
                    "data": {
                      "$ref": "#/components/schemas/User"
                    }
                  },
                  "required": ["code", "message", "data"]
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "User": {
        "type": "object",
        "description": "用户信息模型",
        "properties": {
          "id": {
            "type": "integer",
            "description": "用户唯一标识符",
            "example": 123
          },
          "username": {
            "type": "string",
            "description": "用户名（登录用）",
            "example": "zhang_san",
            "minLength": 3,
            "maxLength": 20
          },
          "realName": {
            "type": "string",
            "description": "用户真实姓名",
            "example": "张三"
          },
          "email": {
            "type": "string",
            "format": "email",
            "description": "电子邮箱地址",
            "example": "zhangsan@example.com"
          },
          "phone": {
            "type": "string",
            "description": "手机号码",
            "example": "13800138000",
            "pattern": "^1[3-9]\\d{9}$"
          },
          "status": {
            "type": "string",
            "description": "用户账户状态",
            "enum": ["active", "inactive", "suspended"],
            "x-enum-descriptions": ["正常", "未激活", "已停用"],
            "example": "active"
          },
          "gender": {
            "type": "string",
            "description": "性别",
            "enum": ["male", "female", "other"],
            "x-enum-descriptions": ["男", "女", "其他"],
            "example": "male"
          },
          "age": {
            "type": "integer",
            "description": "年龄",
            "minimum": 1,
            "maximum": 150,
            "example": 28
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "账户创建时间",
            "example": "2024-01-15T10:30:00Z"
          },
          "lastLoginAt": {
            "type": "string",
            "format": "date-time",
            "description": "最后登录时间",
            "example": "2024-07-01T15:45:30Z"
          },
          "profile": {
            "type": "object",
            "description": "用户档案信息",
            "properties": {
              "avatar": {
                "type": "string",
                "format": "uri",
                "description": "头像图片URL",
                "example": "https://example.com/avatars/123.jpg"
              },
              "bio": {
                "type": "string",
                "description": "个人简介",
                "maxLength": 500,
                "example": "热爱编程的软件工程师"
              },
              "location": {
                "type": "string",
                "description": "所在地区",
                "example": "北京市"
              },
              "website": {
                "type": "string",
                "format": "uri",
                "description": "个人网站",
                "example": "https://zhangsan.dev"
              }
            }
          },
          "preferences": {
            "type": "object",
            "description": "用户偏好设置",
            "properties": {
              "language": {
                "type": "string",
                "description": "界面语言",
                "enum": ["zh-CN", "en-US", "ja-JP"],
                "x-enum-descriptions": ["简体中文", "English", "日本語"],
                "default": "zh-CN"
              },
              "timezone": {
                "type": "string",
                "description": "时区设置",
                "example": "Asia/Shanghai"
              },
              "notifications": {
                "type": "object",
                "description": "通知设置",
                "properties": {
                  "email": {
                    "type": "boolean",
                    "description": "是否接收邮件通知",
                    "default": true
                  },
                  "sms": {
                    "type": "boolean",
                    "description": "是否接收短信通知",
                    "default": false
                  },
                  "push": {
                    "type": "boolean",
                    "description": "是否接收推送通知",
                    "default": true
                  }
                }
              }
            }
          }
        },
        "required": ["id", "username", "email", "status"]
      }
    }
  }
};

// 使用示例
async function demonstrateAnnotatedResponse() {
  console.log('🔄 解析包含中文注释的 Swagger 规范...\n');
  
  try {
    // 1. 解析 Swagger 规范
    const parseResult = await parseFromString(JSON.stringify(swaggerSpecWithChineseComments), {
      strictMode: false,
      resolveReferences: true,
      validateSchema: true
    });
    
    console.log('✅ 解析成功!');
    console.log(`📊 API 信息: ${parseResult.spec.info.title} v${parseResult.spec.info.version}\n`);
    
    // 2. 转换为 MCP 工具
    const tools = transformToMCPTools(parseResult.spec, {
      baseUrl: 'https://api.example.com/v1',
      includeDeprecated: false
    });
    
    console.log(`🔧 生成了 ${tools.length} 个 MCP 工具:\n`);
    
    // 3. 模拟调用工具并展示带注释的响应
    for (const tool of tools) {
      console.log(`📋 工具: ${tool.name}`);
      console.log(`📝 描述: ${tool.description}\n`);
      
      // 模拟 API 响应数据
      const mockResponseData = generateMockResponse(tool.name);
      
      // 模拟工具调用
      try {
        const result = await tool.handler({});
        
        // 这里我们手动创建一个带注释的响应来演示
        console.log('📄 增强的响应示例 (包含字段注释):\n');
        
        // 安全地获取文本内容
        const firstContent = result.content[0];
        if (firstContent.type === 'text') {
          console.log(firstContent.text);
        } else {
          console.log('非文本内容类型');
        }
        
        if (result.schemaAnnotations) {
          console.log('\n🔍 Schema 注释信息:');
          console.log(`模型名称: ${result.schemaAnnotations.modelName || '未知'}`);
          console.log(`字段数量: ${Object.keys(result.schemaAnnotations.fieldAnnotations).length}`);
        }
        
      } catch (error) {
        console.log(`❌ 工具调用失败: ${error instanceof Error ? error.message : '未知错误'}`);
        console.log('（这是预期的，因为这只是演示）');
      }
      
      console.log('\n' + '─'.repeat(80) + '\n');
    }
    
  } catch (error) {
    console.error('❌ 处理失败:', error);
  }
}

/**
 * 生成模拟响应数据
 */
function generateMockResponse(toolName: string): any {
  if (toolName === 'getUsers') {
    return {
      code: 200,
      message: "操作成功",
      data: {
        users: [
          {
            id: 123,
            username: "zhang_san",
            realName: "张三",
            email: "zhangsan@example.com",
            phone: "13800138000",
            status: "active",
            gender: "male",
            age: 28,
            createdAt: "2024-01-15T10:30:00Z",
            lastLoginAt: "2024-07-01T15:45:30Z",
            profile: {
              avatar: "https://example.com/avatars/123.jpg",
              bio: "热爱编程的软件工程师",
              location: "北京市",
              website: "https://zhangsan.dev"
            },
            preferences: {
              language: "zh-CN",
              timezone: "Asia/Shanghai",
              notifications: {
                email: true,
                sms: false,
                push: true
              }
            }
          }
        ],
        total: 100,
        pageSize: 20,
        currentPage: 1
      }
    };
  }
  
  if (toolName === 'getUserById') {
    return {
      code: 200,
      message: "操作成功",
      data: {
        id: 123,
        username: "zhang_san",
        realName: "张三",
        email: "zhangsan@example.com",
        status: "active"
      }
    };
  }
  
  return {};
}

// 运行示例
if (require.main === module) {
  demonstrateAnnotatedResponse().catch(console.error);
}

export { demonstrateAnnotatedResponse, swaggerSpecWithChineseComments };
