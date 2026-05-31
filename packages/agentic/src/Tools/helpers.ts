import type { JsonAble, PromiseAble } from '../types';
import type {
  IErrorResultData,
  IJsonResultData,
  IMediaResultData,
  MediaMetadataType,
} from './interface';

/** Concrete {@link IJsonResultData} that holds structured JSON returned by a tool. */
export class JsonResultData implements IJsonResultData {
  public readonly id: string;
  public readonly type: 'json';
  private readonly data: JsonAble;

  /**
   * @param id - Tool call id this result is correlated to.
   * @param data - The structured JSON payload produced by the tool.
   */
  constructor(id: string, data: JsonAble) {
    this.id = id;
    this.type = 'json' as const;
    this.data = data;
  }

  body(): PromiseAble<JsonAble> {
    return this.data;
  }
}

/**
 * Concrete {@link IMediaResultData} that holds base64-encoded binary content
 * (image, audio, video, document, or text) returned by a tool.
 */
export class MediaResultData implements IMediaResultData {
  public readonly id: string;
  public readonly type: 'media';
  private readonly meta: MediaMetadataType;
  private readonly data: string;

  /**
   * @param id - Tool call id this result is correlated to.
   * @param param - Media payload. Provide all fields of {@link MediaMetadataType} except
   *   `format` (always `'base64'`), plus the base64-encoded `data` string.
   */
  constructor(id: string, param: Omit<MediaMetadataType, 'format'> & { data: string }) {
    this.id = id;
    this.type = 'media' as const;
    this.data = param.data;
    this.meta = {
      format: 'base64' as const,
      name: param.name,
      mediatype: param.mediatype,
      contenttype: param.contenttype,
    } as unknown as MediaMetadataType;
  }

  metadata(): PromiseAble<MediaMetadataType> {
    return this.meta;
  }

  body(): PromiseAble<string> {
    return this.data;
  }
}

/**
 * Concrete {@link IErrorResultData} produced when a tool call throws or returns an error.
 * The original `Error` object is preserved for inspection alongside the formatted body.
 */
export class ErrorResultData implements IErrorResultData {
  public readonly id: string;
  public readonly type: 'error';
  /** The original error, available for programmatic inspection. */
  public readonly error: Error;

  /**
   * @param id - Tool call id this result is correlated to.
   * @param error - The error thrown or returned by the tool.
   */
  constructor(id: string, error: Error) {
    this.id = id;
    this.type = 'error' as const;
    this.error = error;
  }

  /** Returns a formatted string: `[ErrorName] error message`. */
  body(): PromiseAble<string> {
    return `[${this.error.name}] ${this.error.message}`;
  }
}
