import type Anthropic from '@anthropic-ai/sdk';
import type { CommonIntegrationConfig } from '../types';

export type AnthropicLlmIntegrationConfig = {
  /**
   * Configuration strictly for the model invocation parameters passed to the Anthropic SDK.
   *
   * Common parameters include:
   * - `model`: The model ID (e.g., `claude-sonnet-4-20250514`, `claude-3-5-sonnet-20241022`).
   * - `temperature`: Controls randomness (0-1).
   * - `max_tokens`: Limits the generation length (required by Anthropic).
   *
   * @default
   * { model: 'claude-sonnet-4-20250514', max_tokens: 4096, temperature: 0 }
   */
  invocationParam?: Pick<
    Anthropic.MessageCreateParamsNonStreaming,
    'model' | 'temperature' | 'max_tokens'
  >;
} & CommonIntegrationConfig;
