export class AgentError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
