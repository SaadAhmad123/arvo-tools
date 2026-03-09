/** biome-ignore-all lint/suspicious/noExplicitAny: Need to maintain generality */

import type { VersionedArvoContract } from 'arvo-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentFunction } from '../Function/types';
import type { InferenceMessage } from '../Inference/types';
import type { ActionExecuteParam, AgentToolDefinition } from './types';

export const createAgentFunctionToolDefinition = (
  key: string,
  param: AgentFunction,
): AgentToolDefinition => ({
  name: `function_${param.name.replaceAll('.', '_')}`,
  description: param.description,
  schema: zodToJsonSchema(param.schema.input as any),
  server: {
    type: 'functions',
    key,
  },
});

export const createExternalToolDefinition = (
  key: string,
  param: VersionedArvoContract<any, any>,
): AgentToolDefinition => {
  const inputSchema = param.toJsonSchema().accepts.schema;
  // biome-ignore lint/correctness/noUnusedVariables: the parentSubject$$ is to be removed that is why it is unused
  const { parentSubject$$, ...cleanedProperties } =
    inputSchema && 'properties' in inputSchema && inputSchema.properties
      ? inputSchema.properties
      : {};
  const cleanedRequired = (
    inputSchema && 'required' in inputSchema && inputSchema.required ? inputSchema.required : []
  ).filter((item: string) => item !== 'parentSubject$$');

  return {
    name: `external_${(param.accepts.type as string)?.replaceAll('.', '_')}`,
    description: param.description ?? 'No description available',
    schema: {
      ...inputSchema,
      properties: cleanedProperties,
      required: cleanedRequired,
    },
    server: {
      type: 'externals',
      key,
    },
  };
};

export const createToolResponseMessage = (
  param: ActionExecuteParam,
  content: string,
): InferenceMessage => ({
  role: 'user',
  seenCount: 0,
  content: {
    type: 'tool_result',
    toolUseId: param.toolUseId,
    content: content,
  },
});

export const createToolErrorMessage = (param: ActionExecuteParam, error: Error | string) =>
  createToolResponseMessage(param, typeof error === 'string' ? error : error.message);

export const createToolNotExistMessage = (param: ActionExecuteParam): InferenceMessage =>
  createToolResponseMessage(param, `Tool '${param.name}' does not exist.`);
