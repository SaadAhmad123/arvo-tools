import Anthropic from '@anthropic-ai/sdk';
import { cleanString, createArvoOrchestratorContract } from 'arvo-core';
import { ArvoDomain, type EventHandlerFactory, type IMachineMemory } from 'arvo-event-handler';
import * as dotenv from 'dotenv';
import { OpenAI } from 'openai';
import z from 'zod';
import {
  AgentDefaults,
  anthropicLLMIntegration,
  createAgentTool,
  createArvoAgent,
  type IPermissionManager,
  MCPClient,
  openaiLLMIntegration,
} from '../../src';
import { calculatorContract } from './calculator.handler';
import { humanReviewContract } from './contract.human.review';

dotenv.config({ path: '../../.env' });

export const calculatorAgentContract = createArvoOrchestratorContract({
  uri: '#/demo/amas/new/agent/calculator',
  name: 'agent.calculator',
  description: 'This is a calculator agent and an agent which can talk to Astro documentation',
  versions: {
    '1.0.0': {
      init: AgentDefaults.INIT_MULTIMODAL_SCHEMA,
      complete: AgentDefaults.COMPLETE_SCHEMA,
    },
    '2.0.0': {
      init: AgentDefaults.INIT_MULTIMODAL_SCHEMA,
      complete: z.object({
        calculatorOutput: z
          .string()
          .optional()
          .describe('The calculation operation output if there is any'),
        astroOutput: z
          .string()
          .optional()
          .describe('The Astro documentation operation output if there is any'),
      }),
    },
    '3.0.0': {
      init: AgentDefaults.INIT_MULTIMODAL_SCHEMA,
      complete: AgentDefaults.COMPLETE_SCHEMA,
    },
  },
  metadata: {
    alias: 'saad',
  },
});

export const calculatorAgent: EventHandlerFactory<{
  memory: IMachineMemory<Record<string, unknown>>;
  permissionManager: IPermissionManager;
}> = ({ memory, permissionManager }) =>
  createArvoAgent({
    contracts: {
      // Event driven / Async function call interface of the agent
      self: calculatorAgentContract,
      // Event driven services/agents/humans in the event mesh that Agent is allowed to talk to.
      services: {
        calculator: {
          contract: calculatorContract.version('1.0.0'),
        },
        humanReview: {
          contract: humanReviewContract.version('1.0.0'),
          domains: [ArvoDomain.FROM_EVENT_CONTRACT],
        },
      },
    },
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
    // MCP tools that the agent can leverage
    mcp: new MCPClient({
      url: 'https://mcp.docs.astro.build/mcp',
    }),
    llm: openaiLLMIntegration(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })),
    memory,
    onStream: async ({ type, data }) => {
      if (
        !(
          type === 'agent.llm.delta.tool' ||
          type === 'agent.llm.delta.text' ||
          type === 'agent.llm.delta'
        )
      )
        return;
      console.log(JSON.stringify({ type, data }, null, 2));
    },
    permissionManager,
    handler: {
      '1.0.0': {
        // Dynamic context building for the agent when it is initialised.
        context: AgentDefaults.CONTEXT_BUILDER(({ tools }) =>
          cleanString(`
            You are a calculator agent as well as a astro documentation search agent and you must calculate the expression to the best of your abilities.
            If a file is available to you then read it promptly and put all the relevant information from the file for your task in your note by calling tool ${tools.tools.selfTalk.name}.
            Putting the content of the files in tool ${tools.tools.selfTalk.name} is paramount because you can only see the file content once in your lifetime.
            For the tool ${tools.tools.selfTalk.name} you can be as verbose as you feel is necessary so that you can resolve the users request fully and confidently.
            Then, you must create a plan to resolve the request and get approval from the tool ${tools.services.humanReview.name}. You are banned from calling any tool, 
            other than ${tools.tools.selfTalk.name}, before
            getting explicit approval from the tool ${tools.services.humanReview.name}
            If the user requests for information regarding astro, the use the relevant tools.
            If the user requests for a calculations, then use tool ${tools.services.calculator.name}.
            Then, you must use the tool ${tools.services.calculator.name} to perform the calculations.

            Tip: You can call tools ${tools.tools.selfTalk.name} and ${tools.services.humanReview.name} in
            parallel if you can.
          `),
        ),
        output: AgentDefaults.OUTPUT_BUILDER,
      },
      '2.0.0': {
        llmResponseType: 'json',
        llm: anthropicLLMIntegration(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), {
          invocationParam: { stream: true },
        }),
        context: AgentDefaults.CONTEXT_BUILDER(({ tools }) =>
          cleanString(`
            You are a calculator agent as well as a astro documentation search agent and you must calculate the expression to the best of your abilities.
            If a file is available to you then read it promptly and put all the relevant information from the file for your task in your note by calling tool ${tools.tools.selfTalk.name}.
            Putting the content of the files in tool ${tools.tools.selfTalk.name} is paramount because you can only see the file content once in your lifetime.
            For the tool ${tools.tools.selfTalk.name} you can be as verbose as you feel is necessary so that you can resolve the users request fully and confidently.
            Then, you must create a plan to resolve the request and get approval from the tool ${tools.services.humanReview.name}. You are banned from calling any tool, 
            other than ${tools.tools.selfTalk.name}, before
            getting explicit approval from the tool ${tools.services.humanReview.name}
            If the user requests for information regarding astro, the use the relevant tools.
            If the user requests for a calculations, then use tool ${tools.services.calculator.name}.
            Then, you must use the tool ${tools.services.calculator.name} to perform the calculations.

            Tip: You can call tools ${tools.tools.selfTalk.name} and ${tools.services.humanReview.name} in
            parallel if you can.
          `),
        ),
        output: (param) => {
          if (param.type === 'json') {
            const { error, data } = param.outputFormat.safeParse(param.parsedContent ?? {});
            return error ? { error } : { data };
          }
          return { error: new Error('The final output must be output format compliant only') };
        },
      },
      '3.0.0': {
        explicityPermissionRequired: ({ services, mcp }) => [
          services.calculator.name,
          mcp.search_astro_docs.name,
        ],
        llm: openaiLLMIntegration(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })),
        context: AgentDefaults.CONTEXT_BUILDER(({ tools }) =>
          cleanString(`
            You are a calculator agent as well as a astro documentation search agent and you must calculate the expression to the best of your abilities.
            If a file is available to you then read it promptly and put all the relevant information from the file for your task in your note by calling tool ${tools.tools.selfTalk.name}.
            Putting the content of the files in tool ${tools.tools.selfTalk.name} is paramount because you can only see the file content once in your lifetime.
            For the tool ${tools.tools.selfTalk.name} you can be as verbose as you feel is necessary so that you can resolve the users request fully and confidently.
            Then, you must create a plan to resolve the request and get approval from the tool ${tools.services.humanReview.name}. You are banned from calling any tool, 
            other than ${tools.tools.selfTalk.name}, before
            getting explicit approval from the tool ${tools.services.humanReview.name}
            If the user requests for information regarding astro, the use the relevant tools.
            If the user requests for a calculations, then use tool ${tools.services.calculator.name}.
            Then, you must use the tool ${tools.services.calculator.name} to perform the calculations.

            Tip: You can call tools ${tools.tools.selfTalk.name} and ${tools.services.humanReview.name} in
            parallel if you can.
          `),
        ),
        output: AgentDefaults.OUTPUT_BUILDER,
      },
    },
  });
