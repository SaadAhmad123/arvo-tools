import type {
  CreateArvoEvent,
  InferVersionedArvoContract,
  SimpleArvoContract,
  VersionedArvoContract,
} from 'arvo-core';
import type { SimpleArvoContractEmitType } from 'arvo-core/dist/ArvoContract/SimpleArvoContract/types';
import type { NonEmptyArray, PromiseAble } from './types';

/**
 * Contextual information identifying the agent and workflow requesting permission.
 *
 * This source data enables permission decisions to be scoped appropriately—the same
 * tool might be permitted for one agent/workflow/tenant combination but denied for another.
 */
export type PermissionManageSource = {
  /** The agent's identifier. This is the ArvoResumable's handler.source. */
  name: string;

  /**
   * The workflow subject identifier from the originating event.
   * Enables workflow-scoped permissions where authorization applies only to a specific
   * execution context rather than globally.
   */
  subject: string;

  /**
   * The access control context inherited from the triggering event.
   * Typically contains tenant, user, or role information that informs permission decisions
   * (e.g., `'tenant:acme:admin'`, `'user:123:readonly'`).
   */
  accesscontrol: string | null;
};

/**
 * A non-LLM authorization layer for controlling agent tool execution.
 *
 * The Permission Manager provides deterministic, policy-driven control over which tools
 * an agent can execute. This operates independently of LLM reasoning, ensuring that
 * security-critical decisions are not subject to prompt injection, jailbreaks, or
 * other adversarial manipulation of the language model.
 *
 * @remarks
 * **How It Works:**
 *
 * The Permission Manager integrates into the agent's tool execution flow as a gate
 * between LLM tool selection and actual execution:
 *
 * 1. **Check**: When the LLM requests tool calls, the agent invokes {@link get} to
 *    determine which tools are currently authorized.
 *
 * 2. **Execute or Block**: Authorized tools proceed to execution. Unauthorized tools
 *    are collected and blocked from execution.
 *
 * 3. **Request**: For blocked tools, the agent calls {@link requestBuilder} to construct
 *    a permission request event conforming to the manager's {@link contract}.
 *
 * 4. **Suspend**: The agent emits the permission request event and suspends execution,
 *    waiting for an authorization response from an external system (human approver,
 *    policy engine, IAM service, etc.).
 *
 * 5. **Update**: Upon receiving the authorization response, the agent invokes {@link set}
 *    to update the permission database.
 *
 * 6. **Retry**: The LLM, seeing in its conversation history that tools were blocked,
 *    may re-issue the tool calls. With permissions now granted, execution proceeds.
 *
 * This mechanism incurs additional token cost when permissions are denied—the agent
 * must make additional LLM calls after authorization is granted. For security-sensitive
 * operations, this cost is justified by the protection against unauthorized actions.
 *
 * @typeParam T - A versioned Arvo contract defining the permission request/response schema.
 *   The contract specifies what data is sent when requesting permission and what the
 *   authorization response looks like.
 *
 * @example
 * ```typescript
 * // Define a permission contract
 * const toolPermissionContract = createSimpleArvoContract({
 *   uri: '#/permissions/tool-access',
 *   type: 'permission.tool.access',
 *   domain: 'human.interaction'
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
 * // Implement the permission manager
 * class MyPermissionManager implements IPermissionManager<typeof versionedContract> {
 *   public readonly contract = toolPermissionContract.version('1.0.0');
 *   public readonly domains = [ArvoDomain.FROM_EVENT_CONTRACT]; // Use the symbolic reference to use the domain defined in the contract
 *   // public readonly domains = ['human.interaction']; // Both have the exact same result
 *
 *   private permissions = new Map<string, Set<string>>();
 *
 *   private getKey(source: PermissionManageSource): string {
 *     return `${source.accesscontrol}:${source.subject}`;
 *   }
 *
 *   async get(source, tools) {
 *     const key = this.getKey(source);
 *     const granted = this.permissions.get(key) ?? new Set();
 *     return Object.fromEntries(
 *       tools.map(tool => [tool, granted.has(tool)])
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
 *       requestedTools: tools,
 *       reason: `Agent requires permission to execute: ${tools.join(', ')}`,
 *       workflowContext: source.subject,
 *     };
 *   }
 * }
 *
 * // Use with createArvoAgent
 * const agent = createArvoAgent({
 *   // ... other config
 *   permissionManager: new MyPermissionManager(),
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
   * The versioned contract defining the permission request/response schema.
   *
   * The contract follows standard Arvo patterns—it can be versioned, validated,
   * and routed like any other service contract in the event fabric.
   */
  contract: T;

  /**
   * Domain defined event delivery channel hints (e.g., `['human.approval']`)
   * Null domain means that the event is sent to the default event broker of the
   * system and if domains are defined then they are put into that specific
   * delivery channel
   */
  domains: NonEmptyArray<string> | null;

  /**
   * Updates the permission database with an authorization response.
   *
   * Called by the agent when it receives a response to a permission request event.
   * The implementation should extract granted/denied permissions from the response
   * and update its internal state accordingly.
   *
   * @param source - Contextual information identifying the agent and workflow.
   *   Use this to scope permission storage appropriately.
   *
   * @param event - The authorization response event matching the contract's emit schema.
   *   Contains the granted/denied permissions as determined by the authorizing system.
   */
  set(
    source: PermissionManageSource,
    event: InferVersionedArvoContract<T>['emits'][SimpleArvoContractEmitType<
      T['metadata']['rootType']
    >],
  ): PromiseAble<void>;

  /**
   * Checks current permissions for a set of tools.
   *
   * Called by the agent before executing LLM-requested tools. Returns a map indicating
   * which tools are currently authorized for the given source context.
   *
   * @remarks
   * This method should be fast—it's called in the hot path of every tool execution.
   * Consider caching strategies for production implementations.
   *
   * @param source - Contextual information identifying the agent and workflow.
   *   Use this to look up the appropriate permission scope.
   *
   * @param tools - Array of tool names to check permissions for.
   *   These correspond to the tool names as defined in the agent's service contracts, mcp,
   *   and internal tools (e.g., `'service_com_calculator_execute'`, `'internal_self_talk'`).
   *
   * @returns A record mapping each tool name to its authorization status.
   *   `true` indicates the tool is authorized and can execute.
   *   `false` indicates the tool is blocked and requires permission.
   */
  get(source: PermissionManageSource, tools: string[]): PromiseAble<Record<string, boolean>>;

  /**
   * Constructs a permission request event payload for unauthorized tools.
   *
   * Called by the agent when one or more tools fail the permission check. The returned
   * payload is used to create an event that will be emitted to request authorization
   * from an external system (human approver, policy engine, IAM service, etc.).
   *
   * @param source - Contextual information identifying the agent and workflow.
   *   Include relevant details in the request to help approvers make informed decisions.
   *
   * @param tools - Array of tool names that require permission.
   *   These are the tools that failed the {@link get} check.
   *
   * @returns The event payload for the permission request, including:
   *   - All fields required by the contract's `accepts` schema
   */
  requestBuilder(
    source: PermissionManageSource,
    tools: string[],
  ): PromiseAble<InferVersionedArvoContract<T>['accepts']['data']>;
}
