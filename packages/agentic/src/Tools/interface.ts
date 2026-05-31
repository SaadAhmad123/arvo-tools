import type {
  ApplicationContentType,
  AudioContentType,
  ExecutionMetadataType,
  ImageContentType,
  JsonAble,
  PromiseAble,
  TextContentType,
  VideoContentType,
} from '../types';

/** Describes a single tool capability advertised to the LLM. */
export interface IToolMetaData {
  /** Unique name used to route dispatches to this capability. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema describing the expected input arguments. */
  inputSchema: Record<string, unknown>;
}

/** A tool call request produced by the LLM. */
export interface IToolDispatch {
  /** Unique id for this tool call, used to correlate results. */
  id: string;
  /** Name of the capability being invoked. */
  name: string;
  /** Arguments provided by the LLM. */
  args: Record<string, unknown>;
}

/** A tool result containing structured JSON data. */
export interface IJsonResultData {
  /** Correlates this result to its originating {@link IToolDispatch}. */
  id: string;
  type: 'json';
  body(): PromiseAble<JsonAble>;
}

/** Describes the format and media type of a binary result. */
export type MediaMetadataType = { format: 'base64'; name: string | null } & (
  | { mediatype: 'image'; contenttype: ImageContentType }
  | { mediatype: 'audio'; contenttype: AudioContentType }
  | { mediatype: 'video'; contenttype: VideoContentType }
  | { mediatype: 'application'; contenttype: ApplicationContentType }
  | { mediatype: 'text'; contenttype: TextContentType }
);

/** A tool result containing base64-encoded binary or media content. */
export interface IMediaResultData {
  /** Correlates this result to its originating {@link IToolDispatch}. */
  id: string;
  type: 'media';
  /** Returns format and content-type metadata for the binary payload. */
  metadata(): PromiseAble<MediaMetadataType>;
  /** Returns the base64-encoded content. */
  body(): PromiseAble<string>;
}

/** A tool result indicating the tool call failed or threw. */
export interface IErrorResultData {
  /** Correlates this result to its originating {@link IToolDispatch}. */
  id: string;
  type: 'error';
  /** Returns a human-readable description of the error. */
  body(): PromiseAble<string>;
}

/**
 * A tool result signalling that the call cannot be fulfilled internally
 * and must be routed to an external entity.
 *
 * The agent pauses when it encounters this result type and surfaces the
 * pending dispatch for the caller to fulfill. Once the external response
 * arrives, the caller feeds it back via {@link ITool.onExternalResponse}.
 */
export interface IExternalToolResult {
  /** Correlates this result to its originating {@link IToolDispatch}. */
  id: string;
  type: 'external_call';
  /** Returns metadata about the external call (e.g. contract type, uri, version). */
  body(): PromiseAble<JsonAble>;
}

/**
 * Contract for a single tool implementation.
 *
 * A tool exposes one or more named capabilities to the LLM. The agent calls
 * {@link execute} to run dispatches and {@link onExternalResponse} to feed
 * back results for calls that were routed externally.
 *
 * ### Implementor contract
 * - Tools that never produce external calls must implement {@link onExternalResponse}
 *   as a no-op returning `[]`.
 * - Tools that produce external calls must implement {@link onExternalResponse} to
 *   validate the incoming response and return a typed result.
 */
export interface ITool {
  /** Unique name identifying this tool implementation within a {@link Toolset}. */
  name: string;

  /** Initialises any underlying resources (connections, indexes, etc.). */
  init(options?: ExecutionMetadataType): PromiseAble<void>;

  /** Tears down any underlying resources. */
  close(options?: ExecutionMetadataType): PromiseAble<void>;

  /**
   * Returns `true` if this tool can service the given capability name.
   * @param toolName - The capability name to check.
   */
  has(toolName: string, options?: ExecutionMetadataType): PromiseAble<boolean>;

  /**
   * Returns a map of capability name → metadata for all capabilities this tool exposes.
   * Returns `null` if the tool has no capabilities to advertise.
   */
  metadata(options?: ExecutionMetadataType): PromiseAble<Record<string, IToolMetaData> | null>;

  /**
   * Executes one or more tool call dispatches and returns a result for each.
   *
   * A result may be `json`, `media`, `error`, or `external_call`. When any
   * result is `external_call`, the agent pauses and waits for the caller to
   * supply the external response via {@link onExternalResponse}.
   *
   * @param dispatches - Tool call descriptors from the LLM.
   */
  execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): PromiseAble<
    Array<IJsonResultData | IMediaResultData | IErrorResultData | IExternalToolResult>
  >;

  /**
   * Processes an external response for a call that was previously surfaced as
   * an {@link IExternalToolResult} by {@link execute}.
   *
   * Implementations that never produce external calls should return `[]`.
   * Implementations that do should validate the response against their own
   * schema and return a typed result the agent can feed back into the LLM.
   *
   * @param dispatch - The original tool call descriptor from the LLM, used to
   *   correlate the external response with the pending call.
   * @param request - The {@link IExternalToolResult} produced by {@link execute}
   *   for this dispatch, carrying the metadata emitted when the call was first
   *   signalled as external.
   * @param response - The raw response payload supplied by the external entity.
   */
  onExternalResponse(
    dispatch: IToolDispatch,
    request: IExternalToolResult,
    // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
    response: Record<string, any>,
    options?: ExecutionMetadataType,
  ): PromiseAble<Array<IJsonResultData | IMediaResultData | IErrorResultData>>;
}
