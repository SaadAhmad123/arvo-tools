import type {
  InferVersionedArvoContract,
  SimpleArvoContract,
  VersionedArvoContract,
} from 'arvo-core';
import type { SimpleArvoContractEmitType } from 'arvo-core/dist/ArvoContract/SimpleArvoContract/types';
import type { AgentToolDefinition } from './Agent/types';
import type { AgentInternalTool } from './AgentTool/types';
import type { NonEmptyArray, OtelInfoType, PromiseAble } from './types';

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
 *
 * @example
 * ```typescript
 * const permissionContract = createSimpleArvoContract({
 *   uri: '#/permissions/tool-access',
 *   type: 'permission.tool.access',
 *   domain: 'human.interaction',
 *   versions: {
 *     '1.0.0': {
 *       accepts: z.object({
 *         agentId: z.string(),
 *         requestedTools: z.array(z.string()),
 *         reason: z.string(),
 *         workflowContext: z.string(),
 *       }),
 *       emits: z.object({
 *         granted: z.array(z.string()),
 *         denied: z.array(z.string()),
 *         expiresAt: z.string().datetime().optional(),
 *       }),
 *     },
 *   },
 * });
 *
 * class ToolPermissionManager implements IPermissionManager<typeof permissionContract> {
 *   public readonly contract = permissionContract.version('1.0.0');
 *   // public readonly domains = ['human.interaction'];
 *   public readonly domains = [ArvoDomain.FROM_EVENT_CONTRACT];
 *   // Both domains are the same
 *
 *   private permissions = new Map<string, Set<string>>();
 *
 *   private getKey(source: PermissionManagerContext): string {
 *     return `${source.name}:${source.subject}`;
 *   }
 *
 *   async get(source, tools) {
 *     const key = this.getKey(source);
 *     const granted = this.permissions.get(key) ?? new Set();
 *     return Object.fromEntries(
 *       tools.map(tool => [tool.name, granted.has(tool.name)])
 *     );
 *   }
 *
 *   async set(source, event) {
 *     const key = this.getKey(source);
 *     const granted = this.permissions.get(key) ?? new Set();
 *     for (const tool of event.data.granted) {
 *       granted.add(tool);
 *     }
 *     this.permissions.set(key, granted);
 *   }
 *
 *   async requestBuilder(source, tools) {
 *     return {
 *       agentId: source.name,
 *       requestedTools: tools.map(t => t.name),
 *       reason: `Agent requires permission: ${tools.map(t => t.name).join(', ')}`,
 *       workflowContext: source.subject,
 *     };
 *   }
 * }
 *
 * const agent = createArvoAgent({
 *   permissionManager: new ToolPermissionManager(),
 *   handler: {
 *     '1.0.0': {
 *       permissionPolicy: async ({ services }) => [
 *         services.deleteUser.name,
 *         services.processRefund.name
 *       ],
 *       // ... context and output builders
 *     }
 *   }
 * });
 * ```
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
  set(
    source: PermissionManagerContext,
    event: InferVersionedArvoContract<T>['emits'][SimpleArvoContractEmitType<
      T['metadata']['rootType']
    >],
    config: { otelInfo: OtelInfoType },
  ): PromiseAble<void>;

  /**
   * Checks current authorization status for requested tools.
   *
   * Called in the hot path before tool execution. Should be optimized for
   * performance for production.
   *
   * @param source - Context identifying the agent and workflow for permission lookup
   * @param tools - Tool definitions to check (uses agent-oriented names from `tool.name`)
   *
   * @returns Map of tool names to authorization status where `true` permits execution
   *          and `false` blocks execution requiring authorization
   */
  get(
    source: PermissionManagerContext,
    tools: AgentToolDefinition<
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      VersionedArvoContract<any, any> | AgentInternalTool | null
    >[],
    config: { otelInfo: OtelInfoType },
  ): PromiseAble<Record<string, boolean>>;

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
  requestBuilder(
    source: PermissionManagerContext,
    tools: AgentToolDefinition<
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      VersionedArvoContract<any, any> | AgentInternalTool | null
    >[],
    config: { otelInfo: OtelInfoType },
  ): PromiseAble<InferVersionedArvoContract<T>['accepts']['data']>;
}
