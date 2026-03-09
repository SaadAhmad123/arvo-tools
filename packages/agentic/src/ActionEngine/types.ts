/** biome-ignore-all lint/suspicious/noExplicitAny: Need to be general */

import type { VersionedArvoContract } from 'arvo-core';
import type { AgentFunction } from '../Function/types';

export type ActionEngineParam<
  TFunc extends Record<string, AgentFunction> = Record<string, AgentFunction>,
  TExternal extends Record<string, VersionedArvoContract<any, any>> = Record<
    string,
    VersionedArvoContract<any, any>
  >,
> = Partial<{
  functions: TFunc;
  externals: TExternal;
}>;

export type AgentToolDefinition = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  server: {
    type: 'functions' | 'externals';
    key: string;
  };
};

export type ActionExecuteParam = {
  name: string;
  toolUseId: string;
  input: Record<string, any>;
};
