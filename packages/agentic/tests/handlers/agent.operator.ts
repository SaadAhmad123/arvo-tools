import { cleanString, createArvoOrchestratorContract } from 'arvo-core';
import type { EventHandlerFactory, IMachineMemory } from 'arvo-event-handler';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { AgentDefaults, createArvoAgent, openaiLLMIntegration } from '../../src';
import { calculatorAgentContract } from './agent.calculator';

dotenv.config({ path: '../../.env' });

export const operatorAgentContract = createArvoOrchestratorContract({
  uri: '#/demo/amas/agent/operator',
  name: 'agent.operator',
  description: 'An agent that can coordinate among service and agents to complete a task',
  versions: {
    '1.0.0': {
      init: AgentDefaults.INIT_SCHEMA,
      complete: AgentDefaults.COMPLETE_SCHEMA,
    },
  },
});

export const operatorAgent: EventHandlerFactory<{
  memory: IMachineMemory<Record<string, unknown>>;
}> = ({ memory }) =>
  createArvoAgent({
    contracts: {
      self: operatorAgentContract,
      services: {
        calculator: {
          contract: calculatorAgentContract.version('1.0.0'),
        },
      },
    },
    memory,
    llm: openaiLLMIntegration(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })),
    handler: {
      '1.0.0': {
        context: AgentDefaults.CONTEXT_BUILDER(() =>
          cleanString(`
          You are any AI agent which can coordinate with other agents and tools
          in the systems available to you to resolve user requests  
        `),
        ),
        output: AgentDefaults.OUTPUT_BUILDER,
      },
    },
  });
