import type { Span } from '@opentelemetry/api';
import type {
  ArvoContract,
  ArvoOrchestratorContract,
  ArvoSemanticVersion,
  CreateArvoEvent,
  InferVersionedArvoContract,
  VersionedArvoContract,
} from 'arvo-core';
import type { IMachineMemory } from 'arvo-event-handler';
import type z from 'zod';
import type { AgentInternalTool } from '../AgentTool/types';
import type {
  AgentLLMIntegration,
  AgentLLMIntegrationOutput,
  AgentLLMIntegrationParam,
} from '../Integrations/types';
import type { IMCPClient } from '../interfaces.mcp';
import type { IPermissionManager } from '../interfaces.permission.manager';
import type { NonEmptyArray, PromiseAble } from '../types';
import type {
  AgentMediaContentSchema,
  AgentMessageContentSchema,
  AgentMessageSchema,
  AgentTextContentSchema,
  AgentToolCallContentSchema,
  AgentToolResultContentSchema,
} from './schema';
import type { AgentStreamListener } from './stream/types';

/** Represents a pure text block in the conversation history. */
export type AgentTextContent = z.infer<typeof AgentTextContentSchema>;

/** Represents media (images/files) passed to the Agent, usually for multimodal models. */
export type AgentMediaContent = z.infer<typeof AgentMediaContentSchema>;

/** Represents the output from a tool execution, fed back to the LLM. */
export type AgentToolResultContent = z.infer<typeof AgentToolResultContentSchema>;

/** Represents the LLM's request to execute a tool. */
export type AgentToolCallContent = z.infer<typeof AgentToolCallContentSchema>;

/** Union of all possible content types within an Agent's conversation message. */
export type AgentMessageContent = z.infer<typeof AgentMessageContentSchema>;

/**
 * A single message in the Agent's conversation history (User, Assistant, or Tool role).
 * This is the Arvo-standard format which is adapted to specific LLM provider formats (e.g., OpenAI, Anthropic)
 * by the integration layer.
 */
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// biome-ignore lint/suspicious/noExplicitAny: Needs to be general
export type AnyArvoOrchestratorContract = ArvoOrchestratorContract<any, any>;

// biome-ignore lint/suspicious/noExplicitAny: Needs to be genral
export type AnyArvoContract = ArvoContract<any, any, any>;

/**
 * Defines a Distributed Tool (Arvo Service) available to the Agent.
 *
 * Unlike Internal Tools, these reference remote Event Handlers in your system.
 * When an Agent invokes a Service Contract:
 * 1. The Agent emits an event to the broker.
 * 2. **The Agent Suspends (Sleeps)** and persists state to memory.
 * 3. The remote Service processes the event and replies.
 * 4. The Agent Resumes.
 */
export type AgentServiceContract = {
  /** The Versioned Contract of the service the agent can call. */
  // biome-ignore lint/suspicious/noExplicitAny: Needs to general
  contract: VersionedArvoContract<any, any>;
  /**
   * Specific event domains to route the request to.
   * Useful for distinguishing between event deliver channels (e.g. `human.interaction`).
   */
  domains?: NonEmptyArray<string>;
  /**
   * The execution priority of the tool (Default: 0).
   *
   * Arvo enforces **Priority-Based Batch execution**. If the LLM generates multiple tool calls
   * in a single turn, Arvo will sort them by priority and **only execute the highest priority batch**.
   * All lower priority tool calls in that turn are **dropped**.
   *
   * @remarks
   * This is critical for enforcing "Human-in-the-loop-first" or "Auth-first" workflows.
   *
   * @example
   * **Scenario:** LLM wants to call `calculate_refund` (Priority 0) and `human_approval` (Priority 100) simultaneously.
   * 1. Arvo sees both calls.
   * 2. `human_approval` has higher priority.
   * 3. Arvo emits `human_approval` event and drops `calculate_refund`.
   * 4. Agent suspends.
   * 5. Human approves -> Agent resumes.
   * 6. LLM sees approval, and *now* re-issues the `calculate_refund` call.
   */
  priority?: number;
};

/**
 * Internal metadata used by the Agent Orchestrator to control execution strategy and flow.
 *
 * This configuration determines whether the Agent should Execute immediately (Internal/MCP)
 * or Emit & Suspend (Arvo Service), as well as which tools take precedence in a batch.
 */
export type AgentToolServerConfig<T> = {
  /**
   * The Execution Strategy:
   * - `'arvo'`: Asynchronous (Event-driven) / Distributed. The Agent emits an event and **suspends**.
   * - `'mcp'`: Async / Synchronous / External. The Agent calls the MCP Client and awaits the result.
   * - `'internal'`: Async / Synchronous / Local. The Agent runs the JS function and awaits the result.
   */
  kind: 'arvo' | 'mcp' | 'internal';

  /** The internal identifier for the tool resource. */
  name: string;

  /** The original definition source (Contract or Tool object) used to validate inputs. */
  contract: T;

  /**
   * The Priority Level (Higher = More Important).
   *
   * In the Agentic Orchestration loop, if the LLM generates multiple tool calls in a single turn,
   * the Orchestrator sorts them by priority. It executes the highest priority batch and
   * **silently drops/ignores** all lower priority calls.
   *
   * This is the mechanism used to enforce "Verification First" or "Human Approval First" patterns.
   */
  priority: number;
};

/**
 * The unified definition of a Tool as presented to the LLM Context.
 *
 * This type abstracts away the difference between:
 * - **Arvo Services** (Async/Distributed)
 * - **Internal Tools** (Sync/Local)
 * - **MCP Tools** (External/Standardized)
 *
 * The Agent logic uses `serverConfig.kind` to determine execution strategy.
 */
export type AgentToolDefinition<
  T extends
    | VersionedArvoContract<AnyArvoContract, ArvoSemanticVersion>
    | AgentInternalTool
    | null = null,
> = {
  /** The function name the LLM sees (e.g., `service_calculator_add` or `internal_check_time`). */
  name: string;
  /** The description instructing the LLM on when/how to use this tool. */
  description: string;
  /** JSON Schema defining the tool's arguments. */
  // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
  inputSchema: Record<string, any>;
  /** Internal configuration for execution strategy. */
  serverConfig: AgentToolServerConfig<T>;
};

/**
 * The runtime context provided to the Developer during the Agent's Context Building phase.
 *
 * This object gives you access to the current state of the conversation and the
 * complete list of tools available to the Agent. This allows for dynamic System Prompting
 * (e.g., "You have access to tool X and Y, please use X for..." where X and Y are dynamically retrieved).
 */
export type AgentLLMContext<
  TServiceContract extends Record<string, AgentServiceContract> = Record<
    string,
    AgentServiceContract
  >,
  TTools extends Record<string, AgentInternalTool> = Record<string, AgentInternalTool>,
> = {
  /** The current System Prompt (can be null if not yet set). */
  system: string | null;
  /** The full conversation history up to this point. */
  messages: (Omit<AgentMessage, 'seenCount'> & { seenCount?: number })[];
  /**
   * Catalog of all tools available to the Agent, categorized by type.
   * Useful for meta-prompting (telling the Agent about its own capabilities).
   */
  tools: {
    services: {
      [K in keyof TServiceContract]: AgentToolDefinition<TServiceContract[K]['contract']>;
    };
    mcp: Record<string, AgentToolDefinition<null>>;
    tools: { [K in keyof TTools]: AgentToolDefinition<TTools[K]> };
  };
  /** Tracking for the recursion limit loop. */
  toolInteractions: {
    max: number;
    current: number;
  };
};

/**
 * The "Context Engineering" Hook.
 *
 * This function executes **once** when a new Agent workflow is initialized.
 * Its primary responsibility is to the context engineering for the agent.
 *
 * @remarks
 * **Function Lifecycle:**
 * 1. **Ingest:** Arvo receives an event matching your Contract's `init` schema.
 * 2. **Transform:** This function transforms that typed data (e.g. `{ userId: "123", query: "help" }`)
 *    into the Agent's foundational state (System Prompt + Initial Message Thread).
 * 3. **Persist:** The result is stored in `memory`. Future steps in this workflow (e.g. returning from tools)
 *    will simply append to this history, they will not run this builder again.
 *
 * @param param - Context parameters.
 *
 * @returns The initial state object containing the `system` string and `messages` array.
 *
 * @example
 * ```ts
 * context: async ({ input, tools }) => ({
 *   // Dynamic System Prompt based on available tools
 *   system: `You are a helpful assistant. You have access to: ${Object.keys(tools.services).join(', ')}`,
 *
 *   // Map the Event Data into the first User Message
 *   messages: [
 *     { role: 'user', content: { type: 'text', content: input.data.userQuery } }
 *   ]
 * })
 * ```
 */
export type AgentContextBuilder<
  T extends AnyArvoOrchestratorContract = AnyArvoOrchestratorContract,
  V extends ArvoSemanticVersion = ArvoSemanticVersion,
  TServiceContract extends Record<string, AgentServiceContract> = Record<
    string,
    AgentServiceContract
  >,
  TTools extends Record<string, AgentInternalTool> = Record<string, AgentInternalTool>,
> = (param: {
  lifecycle: AgentLLMIntegrationParam['lifecycle'];
  /** The fully typed input event data for this specific contract version. */
  input: InferVersionedArvoContract<VersionedArvoContract<T, V>>['accepts'];
  /** The agent's self contract reference */
  selfContract: VersionedArvoContract<T, V>;
  /** Catalog of available tools for dynamic prompt injection. */
  tools: AgentLLMContext<TServiceContract, TTools>['tools'];
  /** The Otel span to add logs to */
  span: Span;
  // biome-ignore lint/suspicious/noConfusingVoidType: This is better for UX
}) => PromiseLike<Partial<Pick<AgentLLMContext<TServiceContract>, 'messages' | 'system'>> | void>;

/**
 * The "Output Validation" Hook.
 *
 * This function when the agent resolves the user request and generates the final response (Text or JSON).
 * It is responsible for mapping the Agent's raw output into the strict Output Schema
 * defined by the Agent's Contract.
 */
export type AgentOutputBuilder<
  T extends AnyArvoOrchestratorContract = AnyArvoOrchestratorContract,
  V extends ArvoSemanticVersion = ArvoSemanticVersion,
> = (
  param: Extract<AgentLLMIntegrationOutput, { type: 'text' | 'json' }> & {
    outputFormat: z.ZodTypeAny;
    span: Span;
  },
) => PromiseAble<
  | {
      /** The data matching the Contract's 'emits' schema. */
      data: InferVersionedArvoContract<
        VersionedArvoContract<T, V>
      >['emits'][T['metadata']['completeEventType']]['data'] & {
        __id?: CreateArvoEvent<Record<string, unknown>, string>['id'];
        __executionunits?: CreateArvoEvent<Record<string, unknown>, string>['executionunits'];
      };
    }
  | { error: Error }
>;

/**
 * Configuration object for instantiating a new Arvo Agent.
 *
 * This configuration is strictly typed against your Contract Versions. You cannot instantiate
 * an Agent that does not fully implement all versions defined in its interface.
 */
export type CreateArvoAgentParam<
  TSelfContract extends AnyArvoOrchestratorContract = AnyArvoOrchestratorContract,
  TServiceContract extends Record<string, AgentServiceContract> = Record<
    string,
    AgentServiceContract
  >,
  TTools extends Record<string, AgentInternalTool> = Record<string, AgentInternalTool>,
> = {
  /**
   * The Agent's interface in the Arvo Event Fabric.
   */
  contracts: {
    /**
     * The Orchestrator Contract that defines:
     * - The events this Agent accepts (`init`).
     * - The events this Agent emits (`complete`).
     * - The specific semantic versions supported (e.g., `'1.0.0'`, `'2.0.0'`).
     */
    self: TSelfContract;

    /**
     * A map of external Arvo Services this Agent is permitted to call.
     *
     * @remarks
     * Unlike local `tools`, calling a service here causes the Agent to **emit an event and suspend**.
     * It allows the Agent to orchestrate long-running or distributed workflows.
     *
     * Each service can specify:
     * - `contract`: The versioned contract of the target service
     * - `domains`: Event routing hints (e.g., ['human.interaction'] or [ArvoDomain.FROM_EVENT_CONTRACT])
     * - `priority`: Execution precedence for batch tool calls
     *
     */
    services: TServiceContract;
  };

  /**
   * Because Agents function as "Resumables" (they sleep while waiting for async tools),
   * they require a backend to persist the conversation history and interaction state.
   * - Dev: `SimpleMachineMemory` (In-Memory).
   * - Prod: Redis, PostgreSQL, DynamoDB implementation.
   */
  memory: IMachineMemory<Record<string, unknown>>;

  /**
   * The maximum number of tool-execution loops allowed for a single user request.
   * Prevents the Agent from getting stuck in infinite reasoning loops or burning excessive tokens.
   *
   * @defaultValue 5
   */
  maxToolInteractions?: number;

  /**
   * An optional Model Context Protocol (MCP) client.
   * Gives the agent standardized access to external data sources (Filesystems, GitHub, Databases)
   * without writing custom tool wrappers.
   */
  mcp?: IMCPClient;

  /**
   * Internal tools executed synchronously within the agent's process.
   *
   * Best suited for lightweight operations.
   * Internal tools should complete in milliseconds. For operations requiring
   * network I/O, database access, or extended computation, use Arvo services
   * to avoid blocking the agent's execution.
   *
   * Each tool is created via `createAgentTool()` which adds automatic
   * input validation and OpenTelemetry instrumentation.
   */
  tools?: TTools;

  /**
   * The default mechanism to force the Agent to generate a specific output structure.
   * - `'text'`: Standard conversational response.
   * - `'json'`: Structured Output / JSON Mode (validated against the contract's output schema).
   *
   * Individual versions can override this via their handler configuration,
   * enabling progressive migration from text to structured outputs.
   * @defaultValue 'text'
   */
  llmResponseType?: AgentLLMIntegrationParam['outputFormat']['type'];

  /**
   * Default LLM integration function connecting the agent to its reasoning engine.
   * Individual versions can override this to use different models per version.
   */
  llm: AgentLLMIntegration;

  /**
   * Optional event stream listener for real-time agent activity monitoring.
   *
   * Useful for building real-time UIs or logging.
   * Events include contextual metadata (subject, initiator, agent version) for
   * correlation across distributed traces.
   */
  onStream?: AgentStreamListener;

  /**
   * Optional non-LLM authorization layer for deterministic tool access control.
   *
   * The permission manager enforces security policies outside the LLM's reasoning,
   * preventing prompt injection attacks from bypassing authorization.
   * This pattern is critical for systems requiring explicity permission policy implmentation,
   * compliance enforcement, and defense against AI jailbreaking.
   */
  permissionManager?: IPermissionManager;

  /**
   * Version-specific handler implementations for each contract version.
   *
   * Arvo enforces complete version coverage: you must provide handlers for every
   * version defined in `contracts.self.versions`.
   *
   * Version handlers enable independent evolution of prompts, models, and output
   * schemas without breaking existing consumers of older versions.
   */
  handler: {
    [K in keyof TSelfContract['versions'] & ArvoSemanticVersion]: {
      /**
       * Function defining which tools require explicit permission for this version.
       *
       * Tools not in this list bypass permission checks entirely. This enables
       * selective authorization where only sensitive operations (data deletion,
       * financial transactions, external integrations) require approval while
       * read-only or low-risk tools execute freely.
       *
       * The function receives all available tools (services, MCP, internal) to
       * support dynamic policy decisions based on the tool catalog.
       *
       * @example
       * ```typescript
       * explicityPermissionRequired: async ({ services, tools, mcp }) => [
       *   services.deleteUser.name,
       *   services.processRefund.name,
       *   tools.executeSQL.name,
       *   mcp['some_mcp_tool'].name,
       * ]
       * ```
       */
      explicityPermissionRequired?: (
        tools: AgentLLMContext<TServiceContract, TTools>['tools'],
      ) => PromiseAble<string[]>;

      /**
       * Version-specific override for the LLM response format.
       * Overrides the agent-level `llmResponseType` default for this version only.
       */
      llmResponseType?: AgentLLMIntegrationParam['outputFormat']['type'];

      /**
       * Version-specific override for the LLM integration.
       * Overrides the agent-level `llm` default for this version only.
       * Enables model evolution across versions.
       * Each version can use completely different models or providers without
       * affecting other versions or requiring code changes in consumers.
       */
      llm?: AgentLLMIntegration;

      /**
       * Context engineering function executed once during agent initialization.
       *
       * Transforms the initialization event into the agent's foundational state:
       * - System prompt defining the agent's role and capabilities
       * - Initial message history seeding the conversation
       *
       * The returned context persists in memory and forms the base that all
       * subsequent tool results and LLM responses append to. This function
       * runs only once per workflow—resumptions after service calls do not
       * re-execute the context builder.
       *
       * @example
       * ```typescript
       * context: async ({ input, tools, span }) => ({
       *   system: `You are a customer support agent. Available tools:
       *            - ${tools.services.billing.name}: Access billing data
       *            - ${tools.services.ticketing.name}: Create support tickets`,
       *   messages: [
       *     {
       *       role: 'user',
       *       content: { type: 'text', content: input.data.customerQuery },
       *       seenCount: 0
       *     }
       *   ]
       * })
       * ```
       */
      context: AgentContextBuilder<TSelfContract, K, TServiceContract, TTools>;

      /**
       * Output validation function mapping LLM responses to contract-compliant events.
       * Executes when the agent generates a final response (not a tool call).
       *
       * Returns either:
       * - `{ data: {...} }`: Successfully validated output matching the contract
       * - `{ error: Error }`: Validation failure triggering self-correction loop
       *
       * When validation fails, the agent appends the error to message history
       * and re-invokes the LLM, enabling automatic correction of malformed outputs.
       *
       * @example
       * ```typescript
       * output: ({ content, parsedContent, outputFormat, span }) => {
       *   const result = outputFormat.safeParse(
       *     parsedContent ?? JSON.parse(content)
       *   );
       *
       *   if (result.error) {
       *     return { error: result.error };
       *   }
       *
       *   return { data: result.data };
       * }
       * ```
       */
      output: AgentOutputBuilder<TSelfContract, K>;
    };
  };
};
