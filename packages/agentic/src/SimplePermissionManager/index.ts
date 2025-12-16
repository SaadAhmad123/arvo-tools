import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import {
  ArvoOpenTelemetry,
  exceptionToSpan,
  type InferVersionedArvoContract,
  type VersionedArvoContract,
} from 'arvo-core';
import type { AgentToolDefinition } from '../Agent/types';
import type {
  IPermissionManager,
  PermissionManagerContext,
  ToolAuthorizationState,
} from '../interfaces.permission.manager';
import type { NonEmptyArray, OtelInfoType } from '../types';
import { simplePermissionContract } from './contract';

/**
 * Simple in-memory permission manager for development and testing.
 *
 * Stores permissions in a Map keyed by `${source.name}:${source.subject}`,
 * providing workflow-scoped authorization that persists only for the lifetime
 * of the process.
 *
 * @example
 * ```typescript
 * const agent = createArvoAgent({
 *   permissionManager: new SimplePermissionManager(),
 *   handler: {
 *     '1.0.0': {
 *       permissionPolicy: async ({ services }) => [
 *         services.deleteUser.name
 *       ],
 *       // ... other config
 *     }
 *   }
 * });
 * ```
 */
export class SimplePermissionManager
  implements IPermissionManager<VersionedArvoContract<typeof simplePermissionContract, '1.0.0'>>
{
  static readonly CONTRACT = simplePermissionContract;
  static readonly VERSIONED_CONTRACT = simplePermissionContract.version('1.0.0');
  public readonly contract = simplePermissionContract.version('1.0.0');
  public readonly domains: NonEmptyArray<string> | null;
  readonly permissions = new Map<string, Record<string, boolean>>();
  readonly enableCleanUp: boolean = true;

  constructor(config: { domains: NonEmptyArray<string> | null; enableCleanUp?: boolean }) {
    this.domains = config.domains;
    this.enableCleanUp = config.enableCleanUp ?? true;
  }

  private getKey(source: PermissionManagerContext): string {
    return `${source.name}:${source.subject}`;
  }

  async get(
    source: PermissionManagerContext,
    // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
    tools: AgentToolDefinition<any>[],
    config: { otelInfo: OtelInfoType },
  ): Promise<Record<string, ToolAuthorizationState>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Permission.Check',
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: config.otelInfo.headers,
      },
      spanOptions: {
        attributes: {
          [OpenInferenceSemanticConventions.OPENINFERENCE_SPAN_KIND]:
            OpenInferenceSpanKind.GUARDRAIL,
        },
      },
      fn: async (span) => {
        try {
          const key = this.getKey(source);
          const granted = this.permissions.get(key) ?? {};
          const result: Record<string, ToolAuthorizationState> = Object.fromEntries(
            tools.map((tool) => [
              tool.name,
              ((): ToolAuthorizationState => {
                if (granted[tool.name] === true) return 'APPROVED';
                if (granted[tool.name] === false) return 'DENIED';
                return 'REQUESTABLE';
              })(),
            ]),
          );
          span.setAttribute('tool.permission.map', JSON.stringify(result));
          return result;
        } catch (error) {
          exceptionToSpan(error as Error, span);
          throw error;
        } finally {
          span.end();
        }
      },
    });
  }

  async set(
    source: PermissionManagerContext,
    event: { data: { granted: string[]; denied: string[] } },
    config: { otelInfo: OtelInfoType },
  ): Promise<void> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Permission.Update',
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: config.otelInfo.headers,
      },
      spanOptions: {
        attributes: {
          [OpenInferenceSemanticConventions.OPENINFERENCE_SPAN_KIND]:
            OpenInferenceSpanKind.GUARDRAIL,
        },
      },
      fn: async (span) => {
        try {
          const key = this.getKey(source);
          const granted = this.permissions.get(key) ?? {};
          for (const toolName of event.data.granted) {
            granted[toolName] = true;
          }
          for (const toolName of event.data.denied) {
            granted[toolName] = false;
          }
          this.permissions.set(key, granted);
          span.setAttribute('tool.permission.map', JSON.stringify(granted));
        } catch (error) {
          exceptionToSpan(error as Error, span);
          throw error;
        } finally {
          span.end();
        }
      },
    });
  }

  async requestBuilder(
    source: PermissionManagerContext,
    // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
    tools: AgentToolDefinition<any>[],
    config: { otelInfo: OtelInfoType },
  ): Promise<
    InferVersionedArvoContract<
      VersionedArvoContract<typeof simplePermissionContract, '1.0.0'>
    >['accepts']['data']
  > {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Permission.Request',
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: config.otelInfo.headers,
      },
      spanOptions: {
        attributes: {
          [OpenInferenceSemanticConventions.OPENINFERENCE_SPAN_KIND]:
            OpenInferenceSpanKind.GUARDRAIL,
        },
      },
      fn: async (span) => {
        try {
          const request = {
            agentId: source.name,
            reason: `Agent ${source.name} is requesting permission to execute following tools`,
            requestedTools: Array.from(new Set(tools.map((t) => t.name))),
            toolMetaData: Object.fromEntries(
              tools.map((t) => [
                t.name,
                { name: t.name, originalName: t.serverConfig.name, kind: t.serverConfig.kind },
              ]),
            ),
          };
          span.setAttribute('tool.permission.request', JSON.stringify(request));
          return request;
        } catch (error) {
          exceptionToSpan(error as Error, span);
          throw error;
        } finally {
          span.end();
        }
      },
    });
  }

  async cleanup(
    source: PermissionManagerContext,
    config: { otelInfo: OtelInfoType },
  ): Promise<void> {
    if (!this.enableCleanUp) return;
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Permission.Cleanup',
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: config.otelInfo.headers,
      },
      spanOptions: {
        attributes: {
          [OpenInferenceSemanticConventions.OPENINFERENCE_SPAN_KIND]:
            OpenInferenceSpanKind.GUARDRAIL,
        },
      },
      fn: async (span) => {
        try {
          const key = this.getKey(source);
          this.permissions.delete(key);
          span.setAttribute('tool.permission.cleanup.key', key);
        } catch (error) {
          exceptionToSpan(error as Error, span);
          throw error;
        } finally {
          span.end();
        }
      },
    });
  }
}
