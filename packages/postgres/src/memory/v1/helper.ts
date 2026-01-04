import { Client } from 'pg';

export async function createTableV1(
  connectionString: string,
  config?: {
    dropIfExist?: boolean;
  },
): Promise<void> {
  const client = new Client({ connectionString });

  await client.connect();

  try {
    if (config?.dropIfExist) {
      await client.query(`DROP TABLE IF EXISTS machine_memory_state;`);
      await client.query(`DROP TABLE IF EXISTS machine_memory_lock;`);
      await client.query(`DROP TABLE IF EXISTS machine_memory_hierarchy;`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS machine_memory_state (
        subject VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        execution_status VARCHAR(255) NOT NULL,
        parent_subject VARCHAR(255),
        initiator VARCHAR(255),
        source VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS machine_memory_lock (
        subject VARCHAR(255) PRIMARY KEY,
        locked_at TIMESTAMP NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS machine_memory_hierarchy (
        subject VARCHAR(255) PRIMARY KEY,
        parent_subject VARCHAR(255),
        root_subject VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } finally {
    await client.end();
  }
}
