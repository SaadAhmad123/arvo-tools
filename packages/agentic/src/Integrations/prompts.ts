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

export const jsonPrompt = (schema: string) =>
  cleanString(`
    # Critical JSON Output Requirements
    You must return ONLY a valid JSON object with no additional text, explanations, or formatting outside the required JSON structure.

    ## Mandatory Compliance Rules
    1. The entire response must be a single, parseable JSON object
    2. Use double quotes for all keys and string values
    3. No text, commentary, or explanations before or after the JSON
    4. No markdown code fences (\`\`\`json or \`\`\`) - return raw JSON only
    5. Properly escape special characters: \\n for newlines, \\" for quotes, \\\\ for backslashes
    6. Use literal values: true, false, and null (lowercase, never as strings)
    7. Numbers must not be enclosed in quotes
    8. No comments (// or /* */) or trailing commas anywhere in the JSON
    9. Arrays must use square brackets [], objects must use curly braces {}
    10. All required fields in the schema MUST be present
    11. Do not include fields not defined in the schema
    12. When a field is optional and you have no value, omit it entirely (do not use null unless the schema explicitly allows it)

    ## Schema Specification
    The response must conform exactly to this JSON Schema (Draft-07) structure:
    \`\`\`json
    ${schema}
    \`\`\`

    ## Output Format
    Return ONLY the raw JSON object starting with { and ending with }.
    The output will be parsed directly using JSON.parse(), so any non-compliant formatting will cause a fatal error.

    ## Common Mistakes to Avoid
    - Do NOT wrap the JSON in markdown code blocks
    - Do NOT include any preamble like "Here is the JSON:"
    - Do NOT include any explanation after the JSON
    - Do NOT use single quotes instead of double quotes
    - Do NOT leave trailing commas after the last item in arrays or objects
`);
