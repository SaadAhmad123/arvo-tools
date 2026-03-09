/** biome-ignore-all lint/suspicious/noExplicitAny: Generality is required */

import { cleanString, type VersionedArvoContract } from 'arvo-core';
import type z from 'zod';
import type { AgentFunction } from '../Function/types';
import type { InferenceMessage } from '../Inference/types';
import type { OtelInfoType } from '../types';
import {
  createAgentFunctionToolDefinition,
  createExternalToolDefinition,
  createToolErrorMessage,
  createToolNotExistMessage,
  createToolResponseMessage,
} from './helpers';
import type { ActionEngineParam, ActionExecuteParam, AgentToolDefinition } from './types';

// externals are the tools whose contract is available but they
// can the actions engine cannot address them and only an external
// handler can address those. Exectuing such contracts is not action
// engines purview
export class ActionEngine<
  TFunc extends Record<string, AgentFunction> = Record<string, AgentFunction>,
  TExternal extends Record<string, VersionedArvoContract<any, any>> = Record<
    string,
    VersionedArvoContract<any, any>
  >,
> {
  private _definitions: {
    functions: { [K in keyof TFunc]: AgentToolDefinition };
    externals: { [K in keyof TExternal]: AgentToolDefinition };
  } | null = null;

  public get isInitialized(): boolean {
    return this._definitions !== null;
  }

  public get definitions() {
    if (this._definitions === null)
      throw new Error('ActionEngine: cannot access definitions before calling init().');
    return this._definitions;
  }

  public get tools() {
    if (this._definitions === null)
      throw new Error('ActionEngine: cannot access tools before calling init().');

    const tools: Record<string, AgentToolDefinition> = {};
    for (const category of Object.keys(this._definitions) as Array<
      keyof typeof this._definitions
    >) {
      for (const item of Object.values(this._definitions[category])) {
        tools[item.name] = item;
      }
    }

    return tools;
  }

  constructor(private readonly param?: ActionEngineParam<TFunc, TExternal>) {}

  async init(_options: { otelInfo: OtelInfoType }): Promise<void> {
    if (this.isInitialized) return;

    const funcDefs = {} as { [K in keyof TFunc]: AgentToolDefinition };
    for (const [key, fn] of Object.entries(this.param?.functions ?? ({} as TFunc))) {
      const def = createAgentFunctionToolDefinition(key, fn);
      funcDefs[key as keyof TFunc] = def;
    }

    const externalDef = {} as { [K in keyof TExternal]: AgentToolDefinition };
    for (const [key, contract] of Object.entries(this.param?.externals ?? ({} as TExternal))) {
      const def = createExternalToolDefinition(key, contract);
      externalDef[key as keyof TExternal] = def;
    }

    this._definitions = { functions: funcDefs, externals: externalDef };
  }

  async close(_options: { otelInfo: OtelInfoType }): Promise<void> {
    if (!this.isInitialized) return;
  }

  async execute(
    param: ActionExecuteParam,
    options: { otelInfo: OtelInfoType },
  ): Promise<
    { type: 'message'; data: InferenceMessage[] } | { type: 'external'; data: ActionExecuteParam }
  > {
    const def = this.tools[param.name];

    if (def.server.type === 'externals') {
      const exec = this.param?.externals?.[def.server.key];

      if (!exec) {
        return { type: 'message', data: [createToolNotExistMessage(param)] };
      }

      const parsed = (exec.accepts.schema as z.ZodTypeAny).safeParse(param.input);

      if (parsed.error) {
        return {
          type: 'message',
          data: [
            createToolErrorMessage(
              param,
              cleanString(`
                Invalid data provided to the tool. 
                Please confirm to the tool schema. 
                Error: ${parsed.error.toString()}
              `),
            ),
          ],
        };
      }

      return {
        type: 'external',
        data: {
          ...param,
          input: parsed.data,
        },
      };
    }

    if (def.server.type === 'functions') {
      const exec = this.param?.functions?.[def.server.key];

      if (!exec) {
        return { type: 'message', data: [createToolNotExistMessage(param)] };
      }

      try {
        const resp = await exec.fn(param.input, options);

        if (resp?.type === 'data') {
          return {
            type: 'message',
            data: [createToolResponseMessage(param, JSON.stringify(resp.content))],
          };
        }

        if (resp?.type === 'messages') {
          return {
            type: 'message',
            data: resp.content.map((item) => ({
              seenCount: 0,
              ...item,
            })),
          };
        }

        return {
          type: 'message',
          data: [createToolResponseMessage(param, 'Tool executed successfully')],
        };
      } catch (err) {
        return { type: 'message', data: [createToolErrorMessage(param, err as Error)] };
      }
    }

    return { type: 'message', data: [createToolNotExistMessage(param)] };
  }

  async batch(param: ActionExecuteParam[], options: { otelInfo: OtelInfoType }) {
    const responses = {
      externals: [] as ActionExecuteParam[],
      messages: [] as InferenceMessage[],
    };

    const promises = await Promise.all(param.map((item) => this.execute(item, options)));

    for (const { type, data } of promises) {
      if (type === 'external') {
        responses.externals.push(data);
      }
      if (type === 'message') {
        for (const message of data) {
          responses.messages.push(message);
        }
      }
    }

    return responses;
  }
}
