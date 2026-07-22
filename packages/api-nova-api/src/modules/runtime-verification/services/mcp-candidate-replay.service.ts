import { Injectable } from '@nestjs/common';
import { EndpointTestSampleEntity } from '../../../database/entities/endpoint-test-sample.entity';

type CandidateTool = {
  name: string;
  handler?: (args: Record<string, unknown>) => Promise<any>;
};

@Injectable()
export class McpCandidateReplayService {
  async replay(input: {
    tool: CandidateTool;
    sample: EndpointTestSampleEntity;
  }) {
    if (typeof input.tool.handler !== 'function') {
      throw new Error(`MCP candidate tool '${input.tool.name}' has no executable handler`);
    }
    const args = this.objectPayload(input.sample.requestPayload);
    const startedAt = Date.now();
    const response = await input.tool.handler(args);
    const statusCode = this.httpStatus(response);
    if (statusCode === undefined) {
      throw new Error(`MCP candidate tool '${input.tool.name}' did not report an HTTP status`);
    }
    return {
      statusCode,
      durationMs: Date.now() - startedAt,
      isError: Boolean(response?.isError),
      body: response?.structuredContent?.data ?? response?.content ?? null,
      toolName: input.tool.name,
    };
  }

  private httpStatus(response: any): number | undefined {
    for (const item of Array.isArray(response?.content) ? response.content : []) {
      const value = item?._meta?.httpStatus;
      if (Number.isInteger(value)) return value;
    }
    return undefined;
  }

  private objectPayload(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }
}
