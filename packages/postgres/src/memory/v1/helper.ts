import { Client } from 'pg';
import format from 'pg-format';

export async function createTableV1(
  connectionString: string,
  config: {
    tables: {
      state: string;
      lock: string;
      hierarchy: string;
    };
    dropIfExist?: boolean;
  },
): Promise<void> {
  const client = new Client({ connectionString });

  await client.connect();

  try {
    if (config?.dropIfExist) {
      await client.query(format('DROP TABLE IF EXISTS %I CASCADE;', config.tables.state));
      await client.query(format('DROP TABLE IF EXISTS %I CASCADE;', config.tables.lock));
      await client.query(format('DROP TABLE IF EXISTS %I CASCADE;', config.tables.hierarchy));
    }

    await client.query(
      format(
        `CREATE TABLE IF NOT EXISTS %I (
          subject VARCHAR(255) PRIMARY KEY,
          data JSONB NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          execution_status VARCHAR(255) NOT NULL,
          parent_subject VARCHAR(255),
          initiator VARCHAR(255),
          source VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        config.tables.state,
      ),
    );

    await client.query(
      format(
        `CREATE TABLE IF NOT EXISTS %I (
          subject VARCHAR(255) PRIMARY KEY,
          locked_at TIMESTAMP NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        config.tables.lock,
      ),
    );

    await client.query(
      format(
        `CREATE TABLE IF NOT EXISTS %I (
          subject VARCHAR(255) PRIMARY KEY,
          parent_subject VARCHAR(255),
          root_subject VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        config.tables.hierarchy,
      ),
    );
  } finally {
    await client.end();
  }
}
