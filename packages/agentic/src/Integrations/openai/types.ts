import type OpenAI from 'openai';
import type { AzureOpenAI } from 'openai';
import type { CommonIntegrationConfig } from '../types';

export type OpenAILlmIntegrationConfig<TClient extends OpenAI | AzureOpenAI> = {
  /**
   * Configuration strictly for the model invocation parameters passed to the OpenAI SDK.
   *
   * Common parameters include:
   * - `model`: The model ID (e.g., `gpt-4o`).
   * - `temperature`: Controls randomness.
   * - `max_completion_tokens` or `max_tokens`: Limits the generation length.
   *
   * @default
   * { model: 'gpt-4o', max_completion_tokens: 4096, temperature: 0 }
   */
  invocationParam?: Partial<
    Pick<
      Parameters<TClient['chat']['completions']['create']>[0],
      'model' | 'temperature' | 'max_completion_tokens' | 'stream'
    >
  >;

  /**
   * Configuration for distributed tracing attributes.
   */
  telemetry?: {
    /**
     * The value for the `llm.provider` OpenTelemetry attribute.
     * @default 'openai'
     */
    modelProvider?: string;
    /**
     * The value for the `llm.system` OpenTelemetry attribute.
     * @default 'openai' (or 'azure_openai' if utilizing Azure)
     */
    modelSystem?: string;
  };
} & CommonIntegrationConfig;
