import type { ActionEngine } from '../ActionEngine';
import type { ActionExecuteParam } from '../ActionEngine/types';
import type {
  InferenceFunction,
  InferenceJsonContent,
  InferenceLifecycle,
  InferenceMessage,
  InferenceOutput,
  InferenceParam,
  InferenceTextContent,
} from '../Inference/types';
import type { AgentStreamEvent } from '../Stream/type';
import type { OtelInfoType } from '../types';
import type { AgentParam } from './types';

export class Agent<T extends ActionEngine> {
  readonly engine: T;
  readonly inference: InferenceFunction;
  readonly contraint: AgentParam<T>['constraint'];
  readonly outputFormat: AgentParam<T>['outputFormat'];
  readonly hooks: Required<NonNullable<AgentParam<T>['hooks']>>;
  readonly messages: InferenceMessage[];

  constructor(param: AgentParam<T>) {
    this.engine = param.engine;
    this.messages = param.messages;
    this.inference = param.inference;
    this.contraint = param.constraint;
    this.outputFormat = param.outputFormat;
    this.hooks = {
      pre: param.hooks?.pre ?? ((p) => p),
      post: param.hooks?.post ?? ((p) => p),
    };
  }

  async init(options: { otelInfo: OtelInfoType }) {
    await this.engine.init(options);
  }

  async close(options: { otelInfo: OtelInfoType }) {
    await this.engine.close(options);
  }

  async *execute(options: { otelInfo: OtelInfoType }): AsyncGenerator<
    | { type: 'processing'; data: AgentStreamEvent }
    | {
        type: 'complete';
        data: {
          toolcalls: ActionExecuteParam[];
          content: InferenceTextContent | InferenceMessage | InferenceJsonContent | null;
        };
      }
    | { type: 'error'; data: Error }
  > {
    const { otelInfo } = options;
    const totalTokens = { prompt: 0, completion: 0 };
    let cycle = 0;
    let lifecycle: InferenceLifecycle = 'init';

    while (true) {
      // Enforce max_cycles constraint
      if (this.contraint.type === 'max_cycles' && cycle >= this.contraint.value) {
        return;
      }

      // Build and apply pre-hook
      let inferenceParam: InferenceParam = {
        lifecycle,
        outputFormat: this.outputFormat,
        messages: this.messages,
      };
      const preResult = await this.hooks.pre(inferenceParam, { otelInfo });
      if (preResult) inferenceParam = preResult;

      // Yield the cycle lifecycle event
      const agentStartData = {
        system: null,
        messages: this.messages,
        tools: Object.keys(this.engine.tools),
        llmResponseType:
          this.outputFormat.description ?? this.outputFormat._def.typeName ?? 'unknown',
        toolIteractionCycle: {
          max: this.contraint.type === 'max_cycles' ? this.contraint.value : -1,
          current: cycle,
          exhausted: this.contraint.type === 'max_cycles' && cycle >= this.contraint.value - 1,
        },
      };

      if (lifecycle === 'init') {
        yield { type: 'processing', data: { type: 'agent.init', data: agentStartData } };
      } else if (lifecycle === 'tool_result') {
        yield { type: 'processing', data: { type: 'agent.resume', data: agentStartData } };
      } else {
        yield { type: 'processing', data: { type: 'agent.self.correction', data: agentStartData } };
      }

      // Run inference
      let output: InferenceOutput | null = null;
      for await (const event of this.inference(inferenceParam, { otelInfo })) {
        if (event.type === 'processing') {
          yield { type: 'processing', data: event.data };
        } else if (event.type === 'complete') {
          output = event.data;
        } else {
          yield { type: 'error', data: event.data };
          return;
        }
      }

      if (!output) {
        yield { type: 'error', data: new Error('Inference completed without producing output') };
        return;
      }

      // Apply post-hook
      const postResult = await this.hooks.post(output, { otelInfo });
      if (postResult) output = postResult;

      totalTokens.prompt += output.tokens.prompt;
      totalTokens.completion += output.tokens.completion;

      // Enforce max_tokens constraint
      if (
        this.contraint.type === 'max_tokens' &&
        totalTokens.prompt + totalTokens.completion >= this.contraint.value
      ) {
        yield {
          type: 'complete',
          data: {
            toolcalls: [],
            content: output.complete as InferenceTextContent | InferenceJsonContent | null,
          },
        };
        return;
      }

      // JSON parse error — feed back into the loop
      if (output.complete?.type === 'json' && output.complete.error) {
        this.messages.push({
          role: 'user',
          seenCount: 0,
          content: {
            type: 'text',
            content: `Your previous response was not valid JSON. Error: ${output.complete.error}. Please respond with valid JSON.`,
          },
        });
        lifecycle = 'output_error_feedback';
        cycle++;
        continue;
      }

      // Execute tool calls via the engine
      if (output.toolcalls.length > 0) {
        // Add tool_use messages to history (one per tool call)
        for (const toolcall of output.toolcalls) {
          this.messages.push({ role: 'assistant', seenCount: 0, content: toolcall });
        }

        // Yield tool request events
        for (const toolcall of output.toolcalls) {
          const def = this.engine.tools[toolcall.name];
          if (def?.server.type === 'externals') {
            yield {
              type: 'processing',
              data: {
                type: 'agent.tool.request.delegation',
                data: {
                  tools: [toolcall.name],
                  usage: { prompt: output.tokens.prompt, completion: output.tokens.completion },
                },
              },
            };
          } else {
            yield {
              type: 'processing',
              data: {
                type: 'agent.tool.request',
                data: {
                  tool: {
                    kind: def?.server.type ?? 'function',
                    name: toolcall.name,
                    originalName: def?.server.key ?? toolcall.name,
                  },
                  usage: { prompt: output.tokens.prompt, completion: output.tokens.completion },
                },
              },
            };
          }
        }

        // Batch execute — functions are resolved internally, externals are returned to caller
        const { messages: toolMessages, externals } = await this.engine.batch(output.toolcalls, {
          otelInfo,
        });

        for (const msg of toolMessages) {
          this.messages.push(msg);
        }

        // External tool calls can't be resolved — surface them to the caller
        if (externals.length > 0) {
          yield { type: 'complete', data: { toolcalls: externals, content: null } };
          return;
        }

        lifecycle = 'tool_result';
        cycle++;
        continue;
      }

      // No tool calls — done
      yield {
        type: 'complete',
        data: {
          toolcalls: [],
          content: output.complete as InferenceTextContent | InferenceJsonContent | null,
        },
      };
      return;
    }
  }
}
