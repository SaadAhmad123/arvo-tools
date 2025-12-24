import type {
  InferVersionedArvoContract,
  SimpleArvoContract,
  VersionedArvoContract,
} from 'arvo-core';
import type { SimpleArvoContractEmitType } from 'arvo-core/dist/ArvoContract/SimpleArvoContract/types';
import type { AgentToolCallContent, AgentToolDefinition } from './Agent/types';
import type { AgentInternalTool } from './AgentTool/types';
import type { NonEmptyArray, OtelInfoType, PromiseAble } from './types';

/**
 * Authorization state for agent tool execution.
 *
 * Defines three distinct permission states that control tool access and determine
 * whether permission requests should be initiated for blocked tools.
 */
export type ToolAuthorizationState = 'DENIED' | 'APPROVED' | 'REQUESTABLE';

/**
 * Contextual information identifying the agent and workflow requesting permission.
 *
 * Enables scoped authorization decisions where the same tool might be permitted
 * for one agent/workflow/tenant combination but denied for another.
 */
export type PermissionManagerContext = {
  /**
   * The agent's identifier from the ArvoResumable handler source.
   * Used to scope permissions by agent type (e.g., 'support.agent', 'billing.agent').
   */
  name: string;

  /**
   * The workflow execution identifier from the originating event's subject field.
   * Enables workflow-specific permissions where authorization applies only to
   * a particular execution context rather than globally.
   */
  subject: string;

  /**
   * Access control context inherited from the triggering event.
   * Typically contains tenant, user, or role information informing permission
   * decisions (e.g., 'tenant:acme:admin', 'user:123:readonly').
   */
  accesscontrol: string | null;
};

/**
 * Deterministic authorization layer for agent tool execution control.
 *
 * Provides policy-driven tool access control operating independently of LLM reasoning,
 * ensuring security-critical decisions cannot be bypassed through prompt injection,
 * jailbreaking, or other adversarial manipulation of the language model.
 *
 * @remarks
 * **Authorization Flow:**
 *
 * When an agent requests tools requiring permission:
 * 1. Agent calls `get()` to check current authorizations
 * 2. Blocked tools trigger `requestBuilder()` to create permission request payload
 * 3. Agent emits permission request event and suspends execution
 * 4. External authorizer (human, policy engine, IAM) processes request
 * 5. Authorization response arrives, agent calls `set()` to update permissions
 * 6. Agent resumes, LLM retries tool calls with updated authorizations
 *
 * **Implementation Considerations:**
 *
 * Permission managers should be fast on the read path (hot path during tool execution)
 * and can be slower on the write path (triggered only when authorization changes).
 */
export interface IPermissionManager<
  // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
  T extends VersionedArvoContract<SimpleArvoContract<any, any, any>, any> = VersionedArvoContract<
    // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
    SimpleArvoContract<any, any, any>,
    // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
    any
  >,
> {
  /**
   * Versioned contract defining permission request/response event schemas.
   *
   * Follows standard Arvo contract patterns enabling versioning, validation,
   * and routing like any service contract in the event fabric.
   */
  contract: T;

  /**
   * Event delivery channel routing hints for permission requests.
   *
   * When specified, permission request events are routed to these domains
   * (e.g., `['human.interaction']` for human approval workflows).
   * `null` routes to the default system broker.
   */
  domains: NonEmptyArray<string> | null;

  /**
   * Updates internal permission state with authorization response.
   *
   * Called when the agent receives a permission response event. Extract
   * granted/denied permissions from the event and update internal storage
   * scoped to the provided context.
   *
   * @param source - Context identifying the agent and workflow for scoped storage
   * @param event - Authorization response matching contract's success emission schema
   */
  set(param: {
    source: PermissionManagerContext;
    event: InferVersionedArvoContract<T>['emits'][SimpleArvoContractEmitType<
      T['metadata']['rootType']
    >];
    config: { otelInfo: OtelInfoType };
  }): PromiseAble<void>;

  /**
   * Checks current authorization status for requested tools.
   *
   * Called in the hot path before tool execution. Should be optimized for
   * performance for production.
   *
   * @param source - Context identifying the agent and workflow for permission lookup
   * @param tools - Tool definitions to check (uses agent-oriented names from `tool.name`)
   *
   * @returns Map of tool names to authorization status where 'APPROVED' permits execution,
   *          'DENIED' blocks execution without requesting permission, and 'REQUESTABLE'
   *          blocks execution but triggers a permission request event
   */
  get(param: {
    source: PermissionManagerContext;
    tools: Record<
      string,
      {
        definition: AgentToolDefinition<
          // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
          VersionedArvoContract<any, any> | AgentInternalTool | null
        >;
        requests: Omit<AgentToolCallContent, 'type'>[];
      }
    >;
    config: { otelInfo: OtelInfoType };
  }): PromiseAble<Record<string, ToolAuthorizationState>>;

  /**
   * Constructs permission request event payload for blocked tools.
   *
   * Called when tools fail authorization checks. Build a payload conforming to
   * the contract's `accepts` schema, providing sufficient context for external
   * authorizers (humans, policy engines, IAM services) to make informed decisions.
   *
   * @param source - Context identifying the agent and workflow for the request
   * @param tools - Tool definitions requiring permission (failed `get()` check)
   *
   * @returns Event payload matching contract's accepts schema. Use agent-oriented
   *          tool names from `tools[i].name` for consistency with permission checks.
   */
  requestBuilder(param: {
    source: PermissionManagerContext;
    tools: Record<
      string,
      {
        definition: AgentToolDefinition<
          // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
          VersionedArvoContract<any, any> | AgentInternalTool | null
        >;
        requests: Omit<AgentToolCallContent, 'type'>[];
      }
    >;
    config: { otelInfo: OtelInfoType };
  }): PromiseAble<InferVersionedArvoContract<T>['accepts']['data']>;

  /**
   * Cleanup hook invoked when agent execution completes or fails.
   *
   * Called by ArvoAgent when the workflow reaches a terminal state, either through
   * successful completion (output event emitted) or failure (error thrown or system
   * error event emitted). This provides an opportunity to release resources, clear
   * cached permissions, or perform cleanup operations scoped to the workflow execution.
   *
   * Common use cases include clearing workflow-specific permission cache entries to
   * prevent memory leaks, marking permission requests as complete in external systems,
   * or logging audit trails for compliance.
   *
   * **Important:** If cleanup throws an error during successful agent completion, the entire
   * agent execution will fail and emit a system error event instead of the expected output.
   * Implementations should handle internal errors gracefully or ensure cleanup operations
   * are idempotent and unlikely to fail. For non-critical cleanup operations, consider
   * catching and logging errors internally rather than propagating them.
   *
   * @param source - Context identifying the agent and workflow for cleanup
   */
  cleanup?(param: {
    source: PermissionManagerContext;
    config: { otelInfo: OtelInfoType };
  }): PromiseAble<void>;
}
