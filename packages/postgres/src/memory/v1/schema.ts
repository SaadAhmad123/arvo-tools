import { cleanString } from 'arvo-core';
import type { PoolClient } from 'pg';
import z from 'zod';

const tableSchema = {
  state: {
    structure: cleanString(`
    subject VARCHAR(255) PRIMARY KEY,
    data JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    execution_status VARCHAR(255) NOT NULL,
    parent_subject VARCHAR(255),
    initiator VARCHAR(255),
    source VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `),
    schema: z.object({
      subject: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('NO'),
      }),
      data: z.object({
        data_type: z.literal('jsonb'),
        is_nullable: z.literal('NO'),
      }),
      version: z.object({
        data_type: z.literal('integer'),
        is_nullable: z.literal('NO'),
      }),
      execution_status: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('NO'),
      }),
      parent_subject: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('YES'),
      }),
      initiator: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('YES'),
      }),
      source: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('NO'),
      }),
      created_at: z.object({
        data_type: z.literal('timestamp without time zone'),
        is_nullable: z.literal('YES'),
      }),
      updated_at: z.object({
        data_type: z.literal('timestamp without time zone'),
        is_nullable: z.literal('YES'),
      }),
    }),
  },
  lock: {
    structure: cleanString(`
    subject VARCHAR(255) PRIMARY KEY,
    locked_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `),
    schema: z.object({
      subject: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('NO'),
      }),
      locked_at: z.object({
        data_type: z.literal('timestamp without time zone'),
        is_nullable: z.literal('NO'),
      }),
      expires_at: z.object({
        data_type: z.literal('timestamp without time zone'),
        is_nullable: z.literal('NO'),
      }),
      created_at: z.object({
        data_type: z.literal('timestamp without time zone'),
        is_nullable: z.literal('YES'),
      }),
    }),
  },
  hierarchy: {
    structure: cleanString(`
      subject: VARCHAR(255) PRIMARY KEY
      parent_subject: VARCHAR(255) NULL
      root_subject: VARCHAR(255) NOT NULL
      created_at: TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `),
    schema: z.object({
      subject: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('NO'),
      }),
      parent_subject: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('YES'),
      }),
      root_subject: z.object({
        data_type: z.literal('character varying'),
        is_nullable: z.literal('NO'),
      }),
      created_at: z.object({
        data_type: z.literal('timestamp without time zone'),
        is_nullable: z.literal('YES'),
      }),
    }),
  },
} as const;

export const validateTable = async (
  client: PoolClient,
  name: string,
  schema: keyof typeof tableSchema,
) => {
  const query = `
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = $1;
  `;

  const { rows } = await client.query(query, [name]);
  const expectedSchema = tableSchema[schema];

  if (rows.length === 0) {
    throw new Error(
      cleanString(`
      Table '${name}' does not exist.

      Expected structure:
      ${expectedSchema.structure}
    `),
    );
  }

  const columns = Object.fromEntries(
    rows.map((row) => [
      row.column_name,
      {
        data_type: row.data_type,
        is_nullable: row.is_nullable,
      },
    ]),
  );

  const result = expectedSchema.schema.safeParse(columns);
  if (!result.success) {
    throw new Error(
      cleanString(`
        Table '${name}' structure validation failed.

        Expected structure:
        ${expectedSchema.structure}

        Validation Error:
        ${result.error.message}
      `),
    );
  }
};
