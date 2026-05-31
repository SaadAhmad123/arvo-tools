import type { AgentBudgetTrackerState } from '../AgentBudgetTracker';
import type { Message, ToolResultMessageContent } from '../message.types';
import type { IErrorResultData, IJsonResultData, IMediaResultData } from '../Tools/interface';
import type { JsonAble } from '../types';
import type { AgentState, BufferResult, ToolRequest } from './types';

export function createFreshState(
  messages: Message[],
  budget: AgentBudgetTrackerState,
  system: string | null = null,
): AgentState {
  return {
    status: 'init',
    messages,
    budget,
    toolRequests: [],
    system,
  };
}

export function applyBuffer(state: AgentState, messages: Message[]): BufferResult {
  const updatedMessages = [...state.messages, ...messages];

  const updatedToolRequests: ToolRequest[] = state.toolRequests.map((req) => {
    if (req.state === 'fulfilled') return req;

    const match = messages.find(
      (m) =>
        m.role === 'user' && m.content.some((c) => c.type === 'tool_result' && c.id === req.id),
    );

    if (!match) return req;

    const resultBlock = match.content.find(
      (c): c is ToolResultMessageContent => c.type === 'tool_result' && c.id === req.id,
    );

    if (!resultBlock) return req;

    const responseText = resultBlock.content
      .filter((c) => c.type === 'text')
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');

    let response: JsonAble;
    try {
      response = JSON.parse(responseText) as JsonAble;
    } catch {
      response = { text: responseText };
    }

    return { ...req, state: 'fulfilled' as const, response };
  });

  const shouldResume =
    updatedToolRequests.length > 0 && updatedToolRequests.every((r) => r.state === 'fulfilled');

  return {
    state: { ...state, messages: updatedMessages, toolRequests: updatedToolRequests },
    shouldResume,
  };
}

export async function buildToolResultMessage(
  id: string,
  results: Array<IJsonResultData | IMediaResultData | IErrorResultData>,
): Promise<ToolResultMessageContent> {
  const isError = results.some((r) => r.type === 'error');
  const content: ToolResultMessageContent['content'] = [];

  for (const result of results) {
    if (result.type === 'media') {
      content.push({
        type: 'media',
        contentType: (await result.metadata()).contenttype,
        source: 'base64',
        data: await result.body(),
      });
    } else {
      const body = await result.body();
      content.push({
        type: 'text',
        text: typeof body === 'string' ? body : JSON.stringify(body),
      });
    }
  }

  return { type: 'tool_result', id, isError, content };
}
