import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Transformer } from "../core";
import type { TransformOptions } from "../types";
import { serverDebugLog, serverErrorLog } from "../utils/logger";

/**
 * Initialize tools from an OpenAPI file while keeping transport-sensitive
 * runtime paths quiet by default.
 */
export async function initTools(
  server: McpServer,
  swaggerFile?: string,
  options: TransformOptions = {},
): Promise<void> {
  const transformer = new Transformer();

  try {
    serverDebugLog(
      `Initializing MCP tools from OpenAPI specification${swaggerFile ? `: ${swaggerFile}` : ""}`,
    );

    const tools = await transformer.transformFromFile(swaggerFile, options);
    serverDebugLog(`Generated ${tools.length} tools from OpenAPI specification`);

    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        tool.handler,
      );

      serverDebugLog(`Registered tool: ${tool.name}`);
    }

    serverDebugLog("Tool initialization completed successfully");
  } catch (error) {
    serverErrorLog("Failed to initialize tools:", error);
    throw error;
  }
}

/**
 * Initialize tools from an OpenAPI URL.
 */
export async function initToolsFromUrl(
  server: McpServer,
  url: string,
  options: TransformOptions = {},
): Promise<void> {
  const transformer = new Transformer();

  try {
    serverDebugLog(`Initializing MCP tools from OpenAPI URL: ${url}`);

    const tools = await transformer.transformFromUrl(url, options);
    serverDebugLog(`Generated ${tools.length} tools from OpenAPI URL`);

    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        tool.handler,
      );

      serverDebugLog(`Registered tool: ${tool.name}`);
    }

    serverDebugLog("Tool initialization from URL completed successfully");
  } catch (error) {
    serverErrorLog("Failed to initialize tools from URL:", error);
    throw error;
  }
}

/**
 * Initialize tools from an already loaded OpenAPI spec object.
 */
export async function initToolsFromSpec(
  server: McpServer,
  spec: any,
  options: TransformOptions = {},
): Promise<void> {
  const transformer = new Transformer();

  try {
    serverDebugLog("Initializing MCP tools from OpenAPI specification object");

    const tools = await transformer.transformFromSpec(spec, options);
    serverDebugLog(`Generated ${tools.length} tools from OpenAPI specification`);

    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        tool.handler,
      );

      serverDebugLog(`Registered tool: ${tool.name}`);
    }

    serverDebugLog("Tool initialization from spec completed successfully");
  } catch (error) {
    serverErrorLog("Failed to initialize tools from spec:", error);
    throw error;
  }
}
