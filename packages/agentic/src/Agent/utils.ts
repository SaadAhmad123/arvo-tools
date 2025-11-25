import { SemanticConventions as OpenInferenceSemanticConventions } from '@arizeai/openinference-semantic-conventions';
import type { Span } from '@opentelemetry/api';
import type { ArvoSemanticVersion, VersionedArvoContract } from 'arvo-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { IMCPClient } from '../interfaces.mcp';
import type { OtelInfoType } from '../types';
import type {
  AgentInternalTool,
  AgentLLMIntegrationOutput,
  AgentMessage,
  AgentServiceContract,
  AgentToolCallContent,
  AgentToolDefinition,
  AnyArvoContract,
} from './types.js';

export const generateServiceToolDefinitions = <
  TServiceContract extends Record<string, AgentServiceContract>,
>(
  services: TServiceContract,
) => {
  const serviceTools: Record<
    string,
    AgentToolDefinition<VersionedArvoContract<AnyArvoContract, ArvoSemanticVersion>>
  > = {};
  for (const [key, value] of Object.entries(services)) {
    const inputSchema = value.contract.toJsonSchema().accepts.schema;
    // biome-ignore lint/correctness/noUnusedVariables: the parentSubject$$ is to be removed that is why it is unused
    const { parentSubject$$, ...cleanedProperties } =
      inputSchema && 'properties' in inputSchema && inputSchema.properties
        ? inputSchema.properties
        : {};
    const cleanedRequired = (
      inputSchema && 'required' in inputSchema && inputSchema.required ? inputSchema.required : []
    ).filter((item: string) => item !== 'parentSubject$$');
    serviceTools[key] = {
      name: `service_${(value.contract.accepts.type as string)?.replaceAll('.', '_')}`,
      description: value.contract.description ?? 'No description available',
      inputSchema: {
        ...inputSchema,
        properties: cleanedProperties,
        required: cleanedRequired,
      },
      serverConfig: {
        name: value.contract.accepts.type,
        kind: 'arvo',
        contract: value.contract,
        priority: value.priority ?? 0,
      },
    };
  }
  return serviceTools as unknown as {
    [K in keyof TServiceContract]: AgentToolDefinition<TServiceContract[K]['contract']>;
  };
};

export const generateMcpToolDefinitions = async (
  mcp: IMCPClient | null,
  config: { otelInfo: OtelInfoType },
) => {
  const mcpToolList = (await mcp?.getTools(config)) ?? [];
  const mcpToolPriorityMap = (await mcp?.getToolPriority(config)) ?? {};
  return Object.fromEntries(
    mcpToolList.map((item) => [
      item.name,
      {
        name: `mcp_${item.name.replaceAll('.', '_')}`,
        description: item.description,
        inputSchema: item.inputSchema,
        serverConfig: {
          name: item.name,
          kind: 'mcp',
          contract: null,
          priority: mcpToolPriorityMap[item.name] ?? 0,
        },
      } as AgentToolDefinition<null>,
    ]),
  ) as Record<string, AgentToolDefinition<null>>;
};

export const generateAgentInternalToolDefinitions = <
  TTools extends Record<string, AgentInternalTool>,
>(
  tools: Record<string, AgentInternalTool>,
) => {
  const toolDef: Record<string, AgentToolDefinition<AgentInternalTool>> = {};

  for (const [key, tool] of Object.entries(tools)) {
    toolDef[key] = {
      name: `internal_${tool.name.replaceAll('.', '_')}`,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.input),
      serverConfig: {
        name: key,
        kind: 'internal',
        contract: tool,
        priority: tool.priority ?? 0,
      },
    };
  }

  return toolDef as unknown as {
    [K in keyof TTools]: AgentToolDefinition<TTools[K]>;
  };
};

export const clampStr = (s: string, len: number): string =>
  s.length > len ? `${s.slice(0, len)}...` : s;

export const setOpenInferenceInputAttr = (
  param: {
    llm: {
      provider: string;
      system: string;
      model: string;
      invocationParam: Record<string, unknown>;
    };
    messages: AgentMessage[];
    system: string | null;
    tools: AgentToolDefinition[];
  },
  span: Span,
) => {
  span.setAttributes({
    [OpenInferenceSemanticConventions.LLM_PROVIDER]: param.llm.provider,
    [OpenInferenceSemanticConventions.LLM_SYSTEM]: param.llm.system,
    [OpenInferenceSemanticConventions.LLM_MODEL_NAME]: param.llm.model,
    [OpenInferenceSemanticConventions.LLM_INVOCATION_PARAMETERS]: JSON.stringify(
      param.llm.invocationParam,
    ),
  });
  for (const [index, tool] of param.tools.entries()) {
    span.setAttribute(
      `${OpenInferenceSemanticConventions.LLM_TOOLS}.${index}.${OpenInferenceSemanticConventions.TOOL_JSON_SCHEMA}`,
      JSON.stringify({
        ...tool,
        serverConfig: {
          ...tool.serverConfig,
          contract: tool.serverConfig.contract ? 'Not Shown' : null,
        },
      }),
    );
  }

  if (param.system) {
    span.setAttributes({
      [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_ROLE}`]:
        'system',
      [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TYPE}`]:
        'text',
      [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TEXT}`]:
        param.system,
    });
  }

  for (const [_index, item] of param.messages.entries()) {
    const index = param.system ? _index + 1 : _index;
    span.setAttribute(
      `${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_ROLE}`,
      item.role,
    );
    if (item.content.type === 'text') {
      span.setAttributes({
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TYPE}`]:
          'text',
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TEXT}`]:
          item.content.content,
      });
    }
    if (item.content.type === 'media' && item.content.contentType.type === 'image') {
      span.setAttributes({
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TYPE}`]:
          'text',
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TEXT}`]: `IMAGE: ${clampStr(item.content.content, 100)}`,
      });
    }
    if (item.content.type === 'media' && item.content.contentType.type === 'file') {
      span.setAttributes({
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TYPE}`]:
          'text',
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TEXT}`]: `FILE: ${clampStr(item.content.content, 100)}`,
      });
    }
    if (item.content.type === 'tool_use') {
      span.setAttributes({
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_TOOL_CALLS}.0.${OpenInferenceSemanticConventions.TOOL_CALL_FUNCTION_NAME}`]:
          item.content.name,
        [`${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_TOOL_CALLS}.0.${OpenInferenceSemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`]:
          JSON.stringify({
            param: item.content.input,
            tool_use_id: item.content.toolUseId,
          }),
      });
    }
    if (item.content.type === 'tool_result') {
      span.setAttribute(
        `${OpenInferenceSemanticConventions.LLM_INPUT_MESSAGES}.${index}.${OpenInferenceSemanticConventions.MESSAGE_CONTENTS}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT_TEXT}`,
        JSON.stringify({ result: item.content.content, tool_use_id: item.content.toolUseId }),
      );
    }
  }
};

export const setOpenInferenceToolCallOutputAttr = (
  param: {
    toolCalls: Omit<AgentToolCallContent, 'type'>[];
  },
  span: Span,
) => {
  span.setAttributes({
    [`${OpenInferenceSemanticConventions.LLM_OUTPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_ROLE}`]:
      'assistant',
  });
  if (param.toolCalls?.length) {
    span.setAttributes(
      Object.fromEntries(
        param.toolCalls.flatMap((item, index) => [
          [
            `${OpenInferenceSemanticConventions.LLM_OUTPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_TOOL_CALLS}.${index}.${OpenInferenceSemanticConventions.TOOL_CALL_FUNCTION_NAME}`,
            item.name,
          ],
          [
            `${OpenInferenceSemanticConventions.LLM_OUTPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_TOOL_CALLS}.${index}.${OpenInferenceSemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`,
            JSON.stringify({
              param: item.input,
              tool_use_id: item.toolUseId,
            }),
          ],
        ]),
      ),
    );
  }
};

export const setOpenInferenceUsageOutputAttr = (
  param: AgentLLMIntegrationOutput['usage'],
  span: Span,
) => {
  if (param) {
    span.setAttributes({
      [OpenInferenceSemanticConventions.LLM_TOKEN_COUNT_PROMPT]: param.tokens.prompt,
      [OpenInferenceSemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: param.tokens.completion,
      [OpenInferenceSemanticConventions.LLM_TOKEN_COUNT_TOTAL]:
        param.tokens.completion + param.tokens.prompt,
    });
  }
};

export const setOpenInferenceResponseOutputAttr = (
  param: {
    response: string;
  },
  span: Span,
) => {
  span.setAttributes({
    [`${OpenInferenceSemanticConventions.LLM_OUTPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_ROLE}`]:
      'assistant',
  });
  span.setAttributes({
    [`${OpenInferenceSemanticConventions.LLM_OUTPUT_MESSAGES}.0.${OpenInferenceSemanticConventions.MESSAGE_CONTENT}`]:
      param.response,
  });
};

export const tryParseJson = (str: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
};

export const prioritizeToolCalls = (
  toolCalls: Omit<AgentToolCallContent, 'type'>[],
  nameToToolMap: Record<string, AgentToolDefinition>,
): Omit<AgentToolCallContent, 'type'>[] => {
  const grouped = new Map<number, Omit<AgentToolCallContent, 'type'>[]>();
  for (const request of toolCalls) {
    const priority = nameToToolMap[request.name]?.serverConfig.priority ?? 0;
    const existing = grouped.get(priority) ?? [];
    existing.push(request);
    grouped.set(priority, existing);
  }
  const priorities = Array.from(grouped.keys()).sort((a, b) => b - a);
  const highestPriority = priorities[0] ?? 0;
  return grouped.get(highestPriority) ?? [];
};
