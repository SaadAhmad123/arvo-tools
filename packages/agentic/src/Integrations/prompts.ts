import { cleanString } from 'arvo-core';

/**
 * Standard System Instruction injected when the Agent reaches its `maxToolInteractions` limit.
 *
 * This prompt overrides the Agent's natural tendency to keep calling tools, forcing it to
 * synthesize a final response based on whatever partial data it has managed to collect so far.
 */
export const DEFAULT_TOOL_LIMIT_PROMPT = cleanString(`
  **CRITICAL WARNING: You have reached your tool interaction limit!**
  You must answer the original question using all the data available to you. 
  You have run out of tool call budget. No more tool calls are allowed any more.
  If you cannot answer the query well. Then mention what you have done briefly, what
  can you answer based on the collected data, what data is missing and why you cannot 
  answer any further.  
`);
