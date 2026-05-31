/** Thrown when a dispatch targets a capability name that does not exist in the tool. */
export class ToolNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolNotFoundError';
  }
}

/** Thrown when the LLM's arguments fail Zod validation against the tool's input schema. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
