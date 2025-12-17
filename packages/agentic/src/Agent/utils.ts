import { SemanticConventions as OpenInferenceSemanticConventions } from '@arizeai/openinference-semantic-conventions';
import type { Span } from '@opentelemetry/api';
import type { ArvoSemanticVersion, VersionedArvoContract } from 'arvo-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentInternalTool } from '../AgentTool/types';
import type { AgentLLMIntegrationOutput } from '../Integrations/types';
import type { IMCPClient } from '../interfaces.mcp';
import type { OtelInfoType } from '../types';
import type {
  AgentMessage,
  AgentServiceContract,
  AgentToolCallContent,
  AgentToolDefinition,
  AnyArvoContract,
} from './types.js';

/**
 * Transforms a map of Arvo Service Contracts into LLM-compatible Tool Definitions.
 *
 * This function extracts the `accepts` schema from the contract, strips out internal
 * Arvo fields (like `parentSubject$$`), and formats it for the LLM's context window.
 */
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
        key: [key],
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

/**
 * Fetches available tools from a connected MCP Client and adapts them to the Agent's internal format.
 *
 * This runs at runtime during the Agent execution loop to ensure the tool list is current.
 */
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
          key: [item.name],
          name: item.name,
          kind: 'mcp',
          contract: null,
          priority: mcpToolPriorityMap[item.name] ?? 0,
        },
      } as AgentToolDefinition<null>,
    ]),
  ) as Record<string, AgentToolDefinition<null>>;
};

/**
 * Converts local `AgentInternalTool` definitions (Zod schemas) into JSON Schema for the LLM.
 * Uses `zod-to-json-schema` for the conversion.
 */
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
        key: [key],
        name: tool.name,
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

/** Helper utility to truncate long strings (e.g. Base64 images) in logs/traces. */
export const clampStr = (s: string, len: number): string =>
  s.length > len ? `${s.slice(0, len)}...` : s;

/**
 * Populates the OpenTelemetry Span with all LLM Input data using OpenInference Semantic Conventions.
 *
 * This records:
 * 1. The LLM Config (Provider, Model, System Prompt).
 * 2. The full Conversation History (mapped from Arvo format to OpenInference format).
 * 3. Tool Definitions (so traces show what tools were available).
 * 4. Multi-modal content (Image/File placeholders).
 */
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

/**
 * Records the LLM's generated Tool Calls to the OpenTelemetry Span.
 * Adds attributes for Function Name and JSON Arguments.
 */
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

/**
 * Records Token Usage metrics (Prompt, Completion, Total) to the OpenTelemetry Span.
 */
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

/**
 * Records the LLM's final textual response to the OpenTelemetry Span.
 */
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

/** Safe wrapper around JSON.parse that returns null instead of throwing. */
export const tryParseJson = (str: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
};

/**
 * Implements the Priority-Based Execution logic.
 *
 * Takes a list of requested tool calls, groups them by their configured priority,
 * and returns **only** the batch with the highest priority. All lower priority
 * calls are discarded.
 */
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
