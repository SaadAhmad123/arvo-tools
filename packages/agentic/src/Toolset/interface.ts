import type {
  IErrorResultData,
  IExternalToolResult,
  IJsonResultData,
  IMediaResultData,
  IToolDispatch,
  IToolMetaData,
} from '../Tools/interface';
import type { ExecutionMetadataType, PromiseAble } from '../types';

export interface IToolNotExist {
  id: string;
  type: 'tool_not_exist';
  body(): PromiseAble<IToolDispatch>;
}

/**
 * Represents a collection of tools that can be initialised, queried, and executed
 * as a single unit.
 *
 * Implementations are responsible for routing dispatches to the correct underlying
 * tool and returning a typed result for each one.
 */
export interface IToolset {
  /**
   * Returns `true` if the given compound tool name exists in the current index.
   * Always returns `false` before {@link init} is called.
   *
   * @param toolName - Compound index key of the form `toolKey>toolName`.
   */
  has(toolName: string): boolean;

  /**
   * Initialises all underlying tools and builds the internal dispatch index.
   * Must be called before {@link metadata} or {@link execute}.
   */
  init(options?: ExecutionMetadataType): PromiseAble<void>;

  /**
   * Tears down all underlying tools and clears the dispatch index.
   */
  close(options?: ExecutionMetadataType): PromiseAble<void>;

  /**
   * Returns the metadata for every tool currently registered in the index,
   * keyed by the compound index key (`toolKey>toolName`).
   * Returns an empty object before {@link init} is called.
   */
  metadata(): Record<string, IToolMetaData>;

  /**
   * Dispatches one or more tool calls and returns a result for each.
   * @param dispatches - One or more tool call descriptors from the LLM.
   */
  execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): PromiseAble<
    Array<
      IJsonResultData | IMediaResultData | IErrorResultData | IExternalToolResult | IToolNotExist
    >
  >;

  /**
   * Routes an external response back to the tool that originally produced the
   * {@link IExternalToolResult}, allowing it to validate and transform the response.
   *
   * The original `dispatch` (which carries the compound index key as its `name`) is
   * required for routing. If the key is not found in the index, an {@link IToolNotExist}
   * result is returned.
   *
   * @param dispatch - The original tool call descriptor from the LLM.
   * @param request - The external call result produced by {@link execute}.
   * @param response - The raw response from the external entity.
   */
  onExternalResponse(
    dispatch: IToolDispatch,
    request: IExternalToolResult,
    response: Record<string, unknown>,
    options?: ExecutionMetadataType,
  ): PromiseAble<Array<IJsonResultData | IMediaResultData | IErrorResultData | IToolNotExist>>;
}
