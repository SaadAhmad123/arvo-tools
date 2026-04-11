import type { JsonAble, PromiseAble } from '../types';
import type {
  IErrorResultData,
  IJsonResultData,
  IMediaResultData,
  MediaMetadataType,
} from './interface';

export class JsonResultData implements IJsonResultData {
  public readonly id: string;
  public readonly type: 'json';
  private readonly data: JsonAble;

  constructor(id: string, data: JsonAble) {
    this.id = id;
    this.type = 'json' as const;
    this.data = data;
  }

  body(): PromiseAble<JsonAble> {
    return this.data;
  }
}

export class MediaResultData implements IMediaResultData {
  public readonly id: string;
  public readonly type: 'media';
  private readonly meta: MediaMetadataType;
  private readonly data: string;

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

export class ErrorResultData implements IErrorResultData {
  public readonly id: string;
  public readonly type: 'error';
  public readonly error: Error;

  constructor(id: string, error: Error) {
    this.id = id;
    this.type = 'error' as const;
    this.error = error;
  }

  body(): PromiseAble<string> {
    return `[${this.error.name}] ${this.error.message}`;
  }
}
