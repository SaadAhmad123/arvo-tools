import type { AnyContentType, JsonAble } from './types';

export type TextMessageContent = {
  type: 'text';
  text: string;
};

export type MediaMessageContent = {
  type: 'media';
  contentType: AnyContentType;
  source: 'base64';
  data: string;
};

export type ToolCallMessageContent = {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolResultMessageContent = {
  type: 'tool_result';
  id: string;
  isError: boolean;
  content: Array<TextMessageContent | MediaMessageContent>;
};

export type JsonMessageContent = {
  type: 'json';
  data: JsonAble;
};

export type MessageContent =
  | TextMessageContent
  | MediaMessageContent
  | ToolCallMessageContent
  | ToolResultMessageContent
  | JsonMessageContent;

export type MessageRole = 'user' | 'assistant' | 'system';

export type Message = {
  role: MessageRole;
  content: MessageContent[];
};
