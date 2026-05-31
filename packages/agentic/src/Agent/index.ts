import {
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, cleanString, getOtelHeaderFromSpan } from 'arvo-core';
import { AgentBudgetTracker } from '../AgentBudgetTracker';
import { setSpanError } from '../helpers';
import type { Message, ToolCallMessageContent } from '../message.types';
import { ToolNameEncoder } from '../ToolNameEncoder';
import type {
  IErrorResultData,
  IExternalToolResult,
  IJsonResultData,
  IMediaResultData,
  IToolDispatch,
} from '../Tools/interface';
import { Toolset } from '../Toolset';
import type { ExecutionMetadataType, JsonAble } from '../types';
import { AgentError } from './error';
import { applyBuffer, buildToolResultMessage, createFreshState } from './helpers';
import { AgentStateSchema } from './schema';
import type { AgentParam, AgentState, AgentStreamParam, BufferResult, ToolRequest } from './types';

export class Agent {
  public readonly name: AgentParam['name'];
  private readonly budgetLimits: AgentParam['budget'];
  private readonly core: AgentParam['core'];
  private readonly toolset: AgentParam['toolset'];
  private readonly outputSchema: AgentParam['outputSchema'];
  private readonly system: AgentParam['system'];
  private readonly encoder = new ToolNameEncoder();

  constructor({ name, core, toolset, budget, outputSchema, system }: AgentParam) {
    this.name = name;
    this.core = core;
    this.toolset = toolset;
    this.outputSchema = outputSchema;
    this.budgetLimits = budget;
    this.system = system;
  }

  async init(options?: ExecutionMetadataType): Promise<void> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Agent<${this.name}>.init`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          await this.toolset.init();
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          setSpanError(span, e as Error);
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }

  async close(options?: ExecutionMetadataType): Promise<void> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Agent<${this.name}>.close`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          await this.toolset.close();
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          setSpanError(span, e as Error);
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Entry point for both fresh and resumed runs.
   * Pass `state: null` to start; pass an existing {@link AgentState} to resume.
   * The incoming state is validated against {@link AgentStateSchema} before use.
   */
  async stream({ messages, state, options }: AgentStreamParam): Promise<AgentState> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Agent<${this.name}>.stream`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
          [INPUT_VALUE]: JSON.stringify({
            status: state?.status ?? null,
            messageCount: messages.length,
          }),
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          const otelHeaders = getOtelHeaderFromSpan(span);
          const result =
            state === null
              ? await this.initAgent(messages, { ...options, otelHeaders })
              : await this.resumeAgent(this.parseState(state), messages, {
                  ...options,
                  otelHeaders,
                });

          span.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify({ status: result.status }),
            [OUTPUT_MIME_TYPE]: MimeType.JSON,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (e) {
          setSpanError(span, e as Error);
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Merges incoming messages into state and marks matching tool requests as fulfilled.
   * The incoming state is validated before merging.
   */
  buffer(state: AgentState, messages: Message[], options?: ExecutionMetadataType): BufferResult {
    return ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Agent<${this.name}>.buffer`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: (span) => {
        try {
          span.setStatus({ code: SpanStatusCode.OK });
          return applyBuffer(this.parseState(state), messages);
        } catch (e) {
          setSpanError(span, e as Error);
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Fulfills a pending external tool request by routing the response back through
   * the toolset. The caller only needs the current state, the id of the tool request
   * to fulfill (from {@link AgentState.toolRequests}), and the raw response payload.
   *
   * The agent resolves the dispatch and external call metadata internally from state.
   *
   * @param state - Current agent state containing the pending tool requests.
   * @param toolRequestId - The `id` of the {@link ToolRequest} to fulfill.
   * @param response - The raw response payload from the external handler.
   * @param options - Optional OTel execution metadata for trace propagation.
   */
  async onExternalResponse(
    state: AgentState,
    toolRequestId: string,
    response: Record<string, unknown>,
    options?: ExecutionMetadataType,
  ): Promise<BufferResult> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Agent<${this.name}>.onExternalResponse`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
          [INPUT_VALUE]: JSON.stringify({ toolRequestId }),
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          const parsed = this.parseState(state);

          const toolRequest = parsed.toolRequests.find((r) => r.id === toolRequestId);

          if (!toolRequest) {
            throw new AgentError(
              cleanString(`
                No tool request with id '${toolRequestId}' found in the current state.
                Check state.toolRequests for the correct id before calling onExternalResponse.
              `),
            );
          }

          if (toolRequest.state === 'fulfilled') {
            throw new AgentError(
              cleanString(`
                Tool request '${toolRequestId}' has already been fulfilled.
                Each tool request can only be fulfilled once.
              `),
            );
          }

          if (!toolRequest.request) {
            throw new AgentError(
              cleanString(`
                Tool request '${toolRequestId}' has no recorded external call metadata.
                This request was not produced by an external tool call and cannot be fulfilled
                via onExternalResponse.
              `),
            );
          }

          const otelHeaders = getOtelHeaderFromSpan(span);
          const toolRequestRecord = toolRequest.request;
          const dispatch: IToolDispatch = toolRequest.dispatch;
          const externalResult: IExternalToolResult = {
            id: toolRequestRecord.id,
            type: 'external_call',
            body: () => toolRequestRecord.body as JsonAble,
          };

          const results = await this.toolset.onExternalResponse(
            dispatch,
            externalResult,
            response,
            { otelHeaders },
          );

          const typedResults = results.filter(
            (result): result is IJsonResultData | IMediaResultData | IErrorResultData =>
              result.type === 'json' || result.type === 'media' || result.type === 'error',
          );

          const toolResultContent = await buildToolResultMessage(toolRequestId, typedResults);
          const message: Message = { role: 'user', content: [toolResultContent] };

          const bufferResult = applyBuffer(parsed, [message]);

          span.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify({ shouldResume: bufferResult.shouldResume }),
            [OUTPUT_MIME_TYPE]: MimeType.JSON,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return bufferResult;
        } catch (e) {
          setSpanError(span, e as Error);
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }

  private parseState(state: AgentState): AgentState {
    const result = AgentStateSchema.safeParse(state);
    if (!result.success) {
      throw new AgentError(
        cleanString(`
          Invalid AgentState: the provided state failed schema validation and cannot be used
          safely. This typically means the state was corrupted, manually constructed, or
          produced by an incompatible version of the Agent. Restore a valid state snapshot
          or start fresh via stream({ state: null, messages }).
          Validation errors: ${result.error.message}
        `),
      );
    }
    return result.data;
  }

  private buildSystem() {
    if (!this.system) return null;
    if (typeof this.system === 'string') {
      return this.system;
    }
    const tool = (...parts: [string, ...string[]]): string => {
      const compoundKey = Toolset.buildKey(...parts);
      if (!this.toolset.has(compoundKey)) {
        throw new AgentError(
          cleanString(`
              System prompt references unknown tool '${compoundKey}'.
              Ensure the toolset is initialised and the key parts are correct.
            `),
        );
      }
      return this.encoder.encode(compoundKey);
    };

    return this.system({ tool });
  }

  private async initAgent(
    messages: Message[],
    options: AgentStreamParam['options'] & ExecutionMetadataType,
  ): Promise<AgentState> {
    const budgetState = new AgentBudgetTracker(this.budgetLimits).exportState();
    const freshState = createFreshState(messages, budgetState, this.buildSystem());
    return this.runLoop(freshState, options);
  }

  private async resumeAgent(
    state: AgentState,
    messages: Message[],
    options: AgentStreamParam['options'] & ExecutionMetadataType,
  ): Promise<AgentState> {
    const { state: buffered, shouldResume } = applyBuffer(state, messages);
    if (!shouldResume) {
      return buffered;
    }
    buffered.status = 'resume';
    return this.runLoop(buffered, options);
  }

  private async runLoop(
    state: AgentState,
    options: AgentStreamParam['options'] & ExecutionMetadataType,
  ): Promise<AgentState> {
    const budget = AgentBudgetTracker.fromState(state.budget);

    // Encode compound tool names (e.g. "arvo>com.calc.add") to LLM-safe identifiers
    const encodedTools = Object.values(this.toolset.metadata()).map((meta) => ({
      ...meta,
      name: this.encoder.encode(meta.name),
    }));

    // System message is prepended to every core.stream call but never written to state.messages
    const systemMessages: Message[] = state.system
      ? [{ role: 'system', content: [{ type: 'text', text: state.system }] }]
      : [];

    while (true) {
      if (!budget.shouldContinue()) {
        state.budget = budget.exportState();
        state.status = 'error';
        return state;
      }

      const result = await this.core.stream(
        {
          messages: [...systemMessages, ...state.messages],
          tools: encodedTools,
          outputSchema: this.outputSchema,
          budget,
        },
        options,
      );

      state.budget = budget.exportState();

      if (result.stopReason === 'budget_exhausted') {
        state.messages = result.messages;
        state.status = 'error';
        return state;
      }

      if (result.stopReason === 'end_turn') {
        state.messages = [...state.messages, result.message];
        state.toolRequests = [];
        state.status = 'done';
        return state;
      }

      // tool_use
      state.messages = [...state.messages, result.message];

      const toolCalls = result.message.content.filter(
        (block): block is ToolCallMessageContent => block.type === 'tool_call',
      );

      // Register all tool calls — decode encoded names back to compound keys
      state.toolRequests = toolCalls.map(
        (toolCall): ToolRequest => ({
          id: toolCall.id,
          state: 'pending',
          dispatch: {
            id: toolCall.id,
            name: this.encoder.decode(toolCall.name),
            args: toolCall.args,
          },
          request: null,
          response: null,
        }),
      );

      // Execute via toolset using decoded compound names
      const dispatches: IToolDispatch[] = state.toolRequests.map(
        (toolRequest) => toolRequest.dispatch,
      );
      const toolResults = await this.toolset.execute(dispatches);

      const toolResultContents: Message['content'] = [];

      for (const toolResult of toolResults) {
        if (toolResult.type === 'external_call') {
          const pendingRequest = state.toolRequests.find(
            (toolRequest) => toolRequest.id === toolResult.id,
          );
          if (pendingRequest) {
            pendingRequest.request = {
              id: toolResult.id,
              type: toolResult.type,
              body: (await toolResult.body()) as Record<string, unknown>,
            };
          }
          continue;
        }

        // Internal result — fulfil immediately
        const pendingRequest = state.toolRequests.find(
          (toolRequest) => toolRequest.id === toolResult.id,
        );
        if (pendingRequest) {
          const toolResultMessage = await buildToolResultMessage(toolResult.id, [
            toolResult as IJsonResultData | IMediaResultData | IErrorResultData,
          ]);
          toolResultContents.push(toolResultMessage);
          const bodyText = toolResultMessage.content
            .filter((block) => block.type === 'text')
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('');
          let response: Record<string, unknown>;
          try {
            response = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            response = { text: bodyText };
          }
          pendingRequest.response = response;
          pendingRequest.state = 'fulfilled';
        }
      }

      if (toolResultContents.length > 0) {
        state.messages = [...state.messages, { role: 'user', content: toolResultContents }];
      }

      if (state.toolRequests.some((toolRequest) => toolRequest.state === 'pending')) {
        state.status = 'tool_request';
        return state;
      }

      state.toolRequests = [];
    }
  }
}
