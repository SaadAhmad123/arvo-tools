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
import type {
  IPermissionManager,
  PermissionManagerContext,
  ToolAuthorizationState,
} from '../interfaces.permission.manager';
import type { NonEmptyArray } from '../types';
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
  private readonly _contract = simplePermissionContract.version('1.0.0');
  private readonly _permissions = new Map<string, Record<string, boolean>>();
  private readonly _domains: NonEmptyArray<string> | null;
  private readonly enableCleanUp: boolean;
  private readonly shareToolInputInRequest: boolean;
  private readonly permissionPersistance: 'SINGLE_USE' | 'WORKFLOW_WIDE';

  get permissions() {
    return structuredClone(this._permissions);
  }

  get domains() {
    return structuredClone(this._domains);
  }

  get contract() {
    return this._contract;
  }

  constructor(config: {
    domains: NonEmptyArray<string> | null;
    enableCleanUp?: boolean;
    shareToolInputInRequest?: boolean;
    permissionPersistance?: 'SINGLE_USE' | 'WORKFLOW_WIDE';
  }) {
    this._domains = config.domains;
    this.enableCleanUp = config.enableCleanUp ?? true;
    this.shareToolInputInRequest = config.shareToolInputInRequest ?? true;
    this.permissionPersistance = config.permissionPersistance ?? 'WORKFLOW_WIDE';
  }

  private getKey(source: PermissionManagerContext): string {
    return `${source.name}:${source.subject}`;
  }

  async get({
    source,
    tools,
    config,
  }: Parameters<IPermissionManager['get']>[0]): Promise<Record<string, ToolAuthorizationState>> {
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
          const granted = this._permissions.get(key) ?? {};
          const result: Record<string, ToolAuthorizationState> = Object.fromEntries(
            Object.values(tools).map(({ definition: tool }) => [
              tool.name,
              ((): ToolAuthorizationState => {
                if (granted[tool.name] === true) return 'APPROVED';
                if (granted[tool.name] === false) return 'DENIED';
                return 'REQUESTABLE';
              })(),
            ]),
          );
          span.setAttribute('tool.permission.map', JSON.stringify(result));
          if (this.permissionPersistance === 'SINGLE_USE') {
            // Drain all permissions for the source
            // once they are accessed.
            this._permissions.delete(key);
          }
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

  async set({ source, event, config }: Parameters<IPermissionManager['set']>[0]): Promise<void> {
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
          const granted = this._permissions.get(key) ?? {};
          for (const toolName of event.data.granted) {
            granted[toolName] = true;
          }
          for (const toolName of event.data.denied) {
            granted[toolName] = false;
          }
          this._permissions.set(key, granted);
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

  async requestBuilder({
    source,
    tools,
    config,
  }: Parameters<IPermissionManager['requestBuilder']>[0]): Promise<
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
            requestedTools: Object.values(tools).map((t) => t.definition.name),
            toolMetaData: Object.fromEntries(
              Object.values(tools).map((t) => [
                t.definition.name,
                {
                  name: t.definition.name,
                  originalName: t.definition.serverConfig.name,
                  kind: t.definition.serverConfig.kind,
                  requests: this.shareToolInputInRequest
                    ? t.requests.map((item) => ({ input: item.input }))
                    : null,
                },
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

  async cleanup({
    source,
    config,
  }: Parameters<NonNullable<IPermissionManager['cleanup']>>[0]): Promise<void> {
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
          this._permissions.delete(key);
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
