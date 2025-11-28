# @arvo-tools/agentic

**Official AI Agent toolkit for the Arvo event-driven ecosystem**

[![npm version](https://badge.fury.io/js/@arvo-tools%2Fagentic.svg)](https://www.npmjs.com/package/@arvo-tools/agentic)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`@arvo-tools/agentic` extends Arvo's event-driven architecture with production-grade AI agent capabilities. Agents built with this toolkit operate as standard Arvo event handlers, accepting and emitting events while participating in workflows alongside other handlers in your system. This design philosophy ensures that AI agents aren't isolated or special components in your system but rather first-class citizens in your event-driven infrastructure, capable of seamlessly integrating with existing Arvo-based services, workflows and mesh.

The toolkit provides a robust foundation for building intelligent agents that maintain consistency with Arvo's core principles: contract-first development, strong type safety, and infrastructure independence. Whether you're building a single autonomous agent or orchestrating multiple agents in complex workflows, `@arvo-tools/agentic` offers the abstractions and utilities needed to develop, test, and deploy AI-driven components that behave predictably within your distributed system.

## Installation

Before installing `@arvo-tools/agentic`, you'll need to install the Arvo peer dependencies. While you don't need to adopt the complete Arvo architecture to use Arvo Agent in your application, the peer dependencies are required for the agent to function correctly. These dependencies provide the foundational event-handling infrastructure, type definitions, and runtime utilities that enable agents to communicate effectively within the Arvo ecosystem.

For the most current Arvo peer dependencies and detailed installation instructions, please refer to the [official installation guide](https://www.arvo.land/#install-arvo). The guide includes version compatibility information and platform-specific considerations that will help ensure a smooth setup process.

After installing the peer dependencies, you can add this package to your application using your preferred package manager. The package is distributed through npm and is compatible with all major Node.js package managers:
```bash
npm install @arvo-tools/agentic
```
```bash
yarn add @arvo-tools/agentic
```
```bash
pnpm install @arvo-tools/agentic
```

The package is designed to work seamlessly with TypeScript, providing comprehensive type definitions that enhance development experience and catch potential issues at compile time.

## Core Concepts

### Agents as Event Handlers

Every agent created with `createArvoAgent` is an `ArvoResumable`—a specialized Arvo event handler that coordinates workflows through durable state execution. When an agent receives an event, it reasons about the request using an LLM, executes tools to gather information or perform actions, and emits a completion event with structured results.

**Key characteristics:**
- Accept events conforming to orchestrator contracts
- Maintain conversation history across multiple reasoning iterations
- Suspend and resume automatically when coordinating with external services
- Emit contract-compliant completion events
- Consume zero resources while waiting for service responses

### Tool Modalities

Agents coordinate three distinct types of tools, each with different execution characteristics:

**Internal Tools** are synchronous JavaScript functions that execute within the agent's process. Use these for fast computations, data transformations, or read-only operations. The agent calls them, awaits the result, and continues reasoning in the same execution cycle.

**MCP (Model Context Protocol)** provides standardized access to external systems like filesystems, databases, or APIs.

- **Arvo Services** are other Arvo Event Handlers in your system. When the LLM requests a service tool, the agent emits an event, persists its state to memory, and suspends execution. When the service responds, the agent resumes from where it left off and continues reasoning.

### Execution Flow

The agent follows a ReAct (Reason + Act) pattern:

1. **Initialize**: Receive an input event and build the initial context (system prompt and message history)
2. **Reason**: The LLM analyzes the context and decides what to do next (call tools or generate final output)
3. **Act**: Execute requested tools—internal/MCP tools run immediately, service tools trigger suspension
4. **Resume**: When service responses arrive, load persisted state and return to the Reason step
5. **Complete**: Once the LLM generates final output, validate against the contract schema and emit completion event

This cycle repeats until the agent reaches a conclusion or exhausts its tool interaction quota.

### Priority-Based Tool Execution

When the LLM requests multiple tools simultaneously, Arvo executes only the highest-priority batch and silently drops lower-priority calls. This mechanism helps enforces "priority-first" patterns e.g. authorization tools (priority 100) must execute before sensitive operations (priority 0).

```typescript
tools: {
  normalOperation: createAgentTool({
    name: 'process_data',
    priority: 0, // Default priority
    // ...
  }),
},
services: {
  humanApproval: {
    contract: approvalContract.version('1.0.0'),
    priority: 100, // Executes first, blocks others
  },
}
```

### Permission Management

The permission manager provides deterministic authorization control independent of LLM reasoning. When enabled, tools in the permission policy require explicit approval before execution.

**Authorization workflow:**
1. LLM requests protected tool → Agent execution engine blocks tool execution
2. Agent emits permission request event to configured domain
3. External system (human approver, policy engine, IAM) responds with authorization
4. Agent updates permission database → LLM sees approval in conversation → Retries tool call → Execution proceeds

This architecture prevents prompt injection from bypassing security controls—authorization happens outside the LLM's decision-making process.

## Quick Start

Let's build a simple weather agent that uses an internal tool to check the current time.

**Step 1: Define the agent's contract**

The contract specifies what events the agent accepts and what it emits upon completion.

```typescript
import { createArvoOrchestratorContract } from 'arvo-core';
import { AgentDefaults } from '@arvo-tools/agentic'
import { z } from 'zod';

const weatherAgentContract = createArvoOrchestratorContract({
  uri: '#/agents/weather',
  name: 'agent.weather',
  description: 'Provides weather information',
  versions: {
    '1.0.0': {
      init: AgentDefaults.INIT_SCHEMA,
      complete: AgentDefaults.COMPLETE_SCHEMA,
    },
  },
});
```

**Step 2: Create internal tools**

Tools are Typescript functions wrapped with Zod validation and OpenTelemetry instrumentation.

```typescript
import { createAgentTool } from '@arvo-tools/agentic';

const timeChecker = createAgentTool({
  name: 'get_current_time',
  description: 'Returns the current server time in ISO format',
  input: z.object({}).passthrough(),
  output: z.object({ time: z.string() }),
  fn: async () => ({
    time: new Date().toISOString(),
  }),
});
```

**Step 3: Configure the LLM integration**

Choose an LLM provider and configure its parameters.

```typescript
import { openaiLLMIntegration } from '@arvo-tools/agentic';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
dotenv.config()

const llm = openaiLLMIntegration(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  {
    invocationParam: {
      model: 'gpt-4o',
      temperature: 0.7,
      max_completion_tokens: 2048,
    },
  }
);
```

**Step 4: Create the agent**

Combine the contract, tools, and LLM into an agent handler.

```typescript
import { createArvoAgent, AgentDefaults } from '@arvo-tools/agentic';
import { SimpleMachineMemory, EventHandlerFactory, type IMachineMemory } from 'arvo-event-handler';

export const weatherAgent: EventHandlerFactory<{
  memory: IMachineMemory<Record<string, unknown>>;
}> = ({ memory }) =>
  createArvoAgent({
    contracts: {
      self: weatherAgentContract,
      services: {}, // Does not coordinate with other Arvo event driven services =
    },
    tools: {
      timeChecker,
    },
    llm,
    memory,
    handler: {
      '1.0.0': {
        context: AgentDefaults.CONTEXT_BUILDER(({ tools }) => 
          `You are a weather assistant. When discussing forecasts, 
          use ${tools.tools.timeChecker.name} to reference the current time.`
        ),
        output: AgentDefaults.OUTPUT_BUILDER,
      },
    },
  });
```

**Step 5: Execute the agent**

Even though Arvo is an event-driven toolkit, you actually don't required event-driven setup or infrastructure for executing Arvo Agents (and the Arvo Event Handlers).

```typescript
import { createArvoEventFactory } from 'arvo-core';

const memory = new SimpleMachineMemory();
const agent = weatherAgent({ memory });

const inputEvent = createArvoEventFactory(weatherAgentContract.version('1.0.0')).accepts({
  source: 'weather.service',
  data: {
    message: 'What time is it?',
    // This is a default Arvo field injected automatically for advanced operations
    parentSubject$$: null,
  },
});

const result = await agent.execute(inputEvent, { inheritFrom: 'EVENT' });
console.log(result.events[0].data.response);
// Output: "The current time is 2025-01-15T10:30:00.000Z"
```

# Advanced Examples

... coming soon
