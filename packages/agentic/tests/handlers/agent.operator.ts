import { Anthropic } from '@anthropic-ai/sdk';
import { cleanString, createArvoOrchestratorContract } from 'arvo-core';
import type { EventHandlerFactory, IMachineMemory } from 'arvo-event-handler';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import z from 'zod';
import {
  AgentDefaults,
  anthropicLLMIntegration,
  createAgentTool,
  createArvoAgent,
  openaiLLMIntegration,
} from '../../src';
import { calculatorAgentContract } from './agent.calculator';

dotenv.config({ path: '../../.env' });

export const operatorAgentContract = createArvoOrchestratorContract({
  uri: '#/demo/amas/agent/operator',
  name: 'agent.operator',
  description: 'An agent that can coordinate among service and agents to complete a task',
  versions: {
    '1.0.0': {
      init: AgentDefaults.INIT_MULTIMODAL_SCHEMA,
      complete: AgentDefaults.COMPLETE_SCHEMA,
    },
    '2.0.0': {
      init: AgentDefaults.INIT_MULTIMODAL_SCHEMA,
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
    // Inline - Internal tools the agent can leverage
    tools: {
      selfTalk: createAgentTool({
        name: 'tool.self.talk',
        description:
          'A tool for an AI Agent to records its own thoughts so that it can refer to them later via the conversation history',
        input: z.object({
          note_to_self: z.string().describe('The string to record as a note to self'),
        }),
        output: z.object({ recorded: z.boolean() }),
        fn: () => ({ recorded: true }),
      }),
    },
    handler: {
      '1.0.0': {
        context: AgentDefaults.CONTEXT_BUILDER(({ tools }) =>
          cleanString(`
          You are any AI agent which can coordinate with other agents and tools
          in the systems available to you to resolve user requests  
          If a file is available to you then read it promptly and put all the relevant information from the file for your task in your note by calling tool ${tools.tools.selfTalk.name}.
          Putting the content of the files in tool ${tools.tools.selfTalk.name} is paramount because you can only see the file content once in your lifetime.
        `),
        ),
        output: AgentDefaults.OUTPUT_BUILDER,
      },
      '2.0.0': {
        llm: anthropicLLMIntegration(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), {}),
        context: AgentDefaults.CONTEXT_BUILDER(({ tools }) =>
          cleanString(`
          You are any AI agent which can coordinate with other agents and tools
          in the systems available to you to resolve user requests  
          If a file is available to you then read it promptly and put all the relevant information from the file for your task in your note by calling tool ${tools.tools.selfTalk.name}.
          Putting the content of the files in tool ${tools.tools.selfTalk.name} is paramount because you can only see the file content once in your lifetime.
        `),
        ),
        output: AgentDefaults.OUTPUT_BUILDER,
      },
    },
  });
