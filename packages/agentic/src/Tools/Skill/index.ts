import fs from 'node:fs/promises';
import {
  INPUT_VALUE,
  MimeType,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  ArvoOpenTelemetry,
  getOtelHeaderFromSpan,
  OpenInferenceSpanKind,
  type OpenTelemetryHeaders,
} from 'arvo-core';
import matter from 'gray-matter';
import { setSpanError } from '../../helpers';
import type { ExecutionMetadataType, JsonAble } from '../../types';
import { ErrorResultData, JsonResultData } from '../helpers';
import type {
  IErrorResultData,
  IJsonResultData,
  IMediaResultData,
  ITool,
  IToolDispatch,
  IToolMetaData,
} from '../interface';
import { findSkillFiles } from './helpers';

export type SkillParam = {
  /** Unique name identifying this skill collection within a {@link Toolset}. */
  name: string;
  /** Absolute path to the directory that contains the skill markdown files. */
  directory: string;
};

type SkillEntry = {
  filePath: string;
  metadata: IToolMetaData;
};

/**
 * An {@link ITool} implementation that exposes a directory of markdown files as
 * individual LLM-callable skills.
 *
 * Each markdown file must have a YAML front-matter block with `name` and
 * `description` fields. When the LLM invokes a skill, the file's body is returned
 * as structured instructions alongside the original arguments.
 *
 * `Skill` never produces external calls, so {@link onExternalResponse} is a
 * no-op returning `[]`.
 */
export class Skill implements ITool {
  public readonly type = 'Skill';
  public readonly name: string;
  private readonly directory: string;
  private skillIndex: Record<string, SkillEntry> = {};

  constructor(param: SkillParam) {
    this.name = param.name;
    this.directory = param.directory;
  }

  /**
   * Scans {@link SkillParam.directory} recursively for markdown files, parses their
   * front-matter, and builds the internal skill index. Files missing `name` or
   * `description` in their front-matter are silently skipped.
   *
   * Must be called before {@link metadata} or {@link execute}.
   *
   * @throws If the directory scan or any file read fails, the error is re-thrown
   *   after recording it on the active OTel span.
   */
  async init(options?: ExecutionMetadataType): Promise<void> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Skill<${this.name}>.init`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          const skillFiles = await findSkillFiles(this.directory);
          this.skillIndex = {};
          for (const filePath of skillFiles) {
            const content = await fs.readFile(filePath, 'utf-8');
            const { data } = matter(content);
            const skillName = data?.name as string | undefined;
            const description = data?.description as string | undefined;
            if (!skillName || !description) continue;
            this.skillIndex[skillName] = {
              filePath,
              metadata: {
                name: skillName,
                description,
                inputSchema: { type: 'object' },
              },
            };
          }
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          setSpanError(span, e as Error);
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }

  /** Clears the skill index. No external connections to close. */
  async close(options?: ExecutionMetadataType): Promise<void> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Skill<${this.name}>.close`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        this.skillIndex = {};
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      },
    });
  }

  /**
   * Returns `true` if a skill with the given name was found during {@link init}.
   * Always returns `false` before {@link init} or after {@link close}.
   */
  has(skillName: string): boolean {
    return skillName in this.skillIndex;
  }

  /**
   * Returns metadata for every skill in the index, keyed by skill name.
   * Returns an empty object before {@link init} or after {@link close}.
   */
  metadata(): Record<string, IToolMetaData> {
    const result: Record<string, IToolMetaData> = {};
    for (const [name, entry] of Object.entries(this.skillIndex)) {
      result[name] = entry.metadata;
    }
    return result;
  }

  private async singleExecute(
    dispatch: IToolDispatch,
    options: { otelHeaders: OpenTelemetryHeaders },
  ): Promise<Array<IJsonResultData | IErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Execute<${dispatch.name}>`,
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: options.otelHeaders,
      },
      fn: async (span) => {
        try {
          const entry = this.skillIndex[dispatch.name];
          if (!entry) {
            throw new Error(`Skill '${dispatch.name}' not found in Skill<${this.name}>`);
          }
          const content = await fs.readFile(entry.filePath, 'utf-8');
          const { content: body } = matter(content);
          span.setStatus({ code: SpanStatusCode.OK });
          return [
            new JsonResultData(dispatch.id, {
              skill: dispatch.name,
              instructions: body.trim(),
              args: dispatch.args,
            } as unknown as JsonAble),
          ];
        } catch (e) {
          const err = setSpanError(span, e as Error);
          return [new ErrorResultData(dispatch.id, err)];
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Reads each dispatched skill file and returns its body as structured instructions.
   * All dispatches are executed in parallel. Missing skills or read errors are caught
   * per-dispatch and returned as {@link IErrorResultData}.
   *
   * Each successful result is a {@link IJsonResultData} with shape
   * `{ skill, instructions, args }`.
   */
  async execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): Promise<Array<IJsonResultData | IErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Skill<${this.name}>`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
          [INPUT_VALUE]: JSON.stringify(dispatches),
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          const otelHeaders = getOtelHeaderFromSpan(span);
          const results = (
            await Promise.all(dispatches.map((d) => this.singleExecute(d, { otelHeaders })))
          ).flat();

          span.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify(
              await Promise.all(
                results.map(async (item) => ({ type: item.type, data: await item.body() })),
              ),
            ),
            [OUTPUT_MIME_TYPE]: MimeType.JSON,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return results;
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * No-op — `Skill` never produces external calls.
   * @returns An empty array.
   */
  onExternalResponse(): Array<IJsonResultData | IMediaResultData | IErrorResultData> {
    return [];
  }
}
