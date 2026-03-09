import type { ActionEngine } from '../ActionEngine';
import type { ActionExecuteParam } from '../ActionEngine/types';
import type {
  InferenceFunction,
  InferenceJsonContent,
  InferenceMessage,
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
  > {}
}
