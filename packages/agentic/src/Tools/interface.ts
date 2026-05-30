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

export interface IToolMetaData {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface IToolDispatch {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface IJsonResultData {
  id: string;
  type: 'json';
  body(): PromiseAble<JsonAble>;
}

export type MediaMetadataType = { format: 'base64'; name: string | null } & (
  | { mediatype: 'image'; contenttype: ImageContentType }
  | { mediatype: 'audio'; contenttype: AudioContentType }
  | { mediatype: 'video'; contenttype: VideoContentType }
  | { mediatype: 'application'; contenttype: ApplicationContentType }
  | { mediatype: 'text'; contenttype: TextContentType }
);

export interface IMediaResultData {
  id: string;
  type: 'media';
  metadata(): PromiseAble<MediaMetadataType>;
  body(): PromiseAble<string>;
}

export interface IErrorResultData {
  id: string;
  type: 'error';
  body(): PromiseAble<string>;
}

export interface IExternalToolResult {
  id: string;
  type: 'external_call';
  body(): PromiseAble<JsonAble>;
}

export interface ITool {
  name: string;
  init(options?: ExecutionMetadataType): PromiseAble<void>;
  close(options?: ExecutionMetadataType): PromiseAble<void>;
  has(toolName: string, options?: ExecutionMetadataType): PromiseAble<boolean>;
  metadata(options?: ExecutionMetadataType): PromiseAble<Record<string, IToolMetaData> | null>;
  execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): PromiseAble<Array<IJsonResultData | IMediaResultData | IErrorResultData | IExternalToolResult>>;
}
