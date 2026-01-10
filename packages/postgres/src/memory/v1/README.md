# PostgreSQL Machine Memory - Version 1

PostgreSQL-backed implementation for distributed workflow state management with optimistic locking, distributed locks, and hierarchical workflow tracking.

## Database Schema Requirements

The implementation requires three PostgreSQL tables with specific schemas. **You must create these tables before connecting** to the machine memory instance. The connection will validate that these tables exist with the correct structure.

### State Table

Stores workflow instance data, versions, execution status, and metadata.

```sql
CREATE TABLE machine_memory_state (
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
```

**Columns:**
- `subject`: Unique workflow instance identifier (primary key)
- `data`: JSONB storage for workflow state data
- `version`: Integer version counter for optimistic locking
- `execution_status`: Current execution status of the workflow
- `parent_subject`: Subject of parent workflow (null for root workflows)
- `initiator`: Identifier of the entity that initiated the workflow
- `source`: Source identifier of the orchestrator managing this workflow
- `created_at`: Timestamp when the workflow was created
- `updated_at`: Timestamp of the last state update

### Lock Table

Manages distributed locks with automatic TTL-based expiration.

```sql
CREATE TABLE machine_memory_lock (
  subject VARCHAR(255) PRIMARY KEY,
  locked_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Columns:**
- `subject`: Workflow instance identifier being locked (primary key)
- `locked_at`: Timestamp when the lock was acquired
- `expires_at`: Timestamp when the lock will automatically expire
- `created_at`: Timestamp when the lock record was created

### Hierarchy Table

Tracks parent-child relationships and root workflow subjects for hierarchical queries.

```sql
CREATE TABLE machine_memory_hierarchy (
  subject VARCHAR(255) PRIMARY KEY,
  parent_subject VARCHAR(255),
  root_subject VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Columns:**
- `subject`: Workflow instance identifier (primary key)
- `parent_subject`: Subject of the immediate parent workflow (null for root workflows)
- `root_subject`: Subject of the root workflow at the top of the hierarchy
- `created_at`: Timestamp when the hierarchy record was created

## Recommended Indexes

While not required, these indexes are highly recommended for optimal performance:

```sql
-- Lock table: Efficient cleanup of expired locks
CREATE INDEX idx_machine_memory_lock_expires_at ON machine_memory_lock(expires_at);

-- Hierarchy table: Fast queries for all workflows in a tree
CREATE INDEX idx_machine_memory_hierarchy_root_subject ON machine_memory_hierarchy(root_subject);

-- Hierarchy table: Fast queries for direct children
CREATE INDEX idx_machine_memory_hierarchy_parent_subject ON machine_memory_hierarchy(parent_subject);
```

## Prisma Schema

If you're using Prisma, you can copy and paste this schema definition:

```prisma
model machine_memory_state {
  subject          String    @id @db.VarChar(255)
  data             Json      @db.JsonB
  version          Int       @default(1)
  execution_status String    @db.VarChar(255)
  parent_subject   String?   @db.VarChar(255)
  initiator        String?   @db.VarChar(255)
  source           String    @db.VarChar(255)
  created_at       DateTime? @default(now()) @db.Timestamp(6)
  updated_at       DateTime? @default(now()) @db.Timestamp(6)
}

model machine_memory_lock {
  subject    String    @id @db.VarChar(255)
  locked_at  DateTime  @db.Timestamp(6)
  expires_at DateTime  @db.Timestamp(6)
  created_at DateTime? @default(now()) @db.Timestamp(6)

  @@index([expires_at])
}

model machine_memory_hierarchy {
  subject        String    @id @db.VarChar(255)
  parent_subject String?   @db.VarChar(255)
  root_subject   String    @db.VarChar(255)
  created_at     DateTime? @default(now()) @db.Timestamp(6)

  @@index([root_subject])
  @@index([parent_subject])
}
```

After adding this to your `schema.prisma` file, run:
```bash
npx prisma db push
```
or
```bash
npx prisma migrate dev
```

## Table Validation

When connecting via `connectPostgresMachineMemory`, the system will automatically validate that:
1. All three tables exist
2. Each table has the required columns
3. Each column has the correct data type
4. Each column has the correct nullable constraint

If validation fails, a descriptive error message will indicate what is missing or incorrect.

## Usage

Connect to the machine memory instance using the factory functions:

```typescript
import { 
  connectPostgresMachineMemory, 
  releasePostgressMachineMemory 
} from '@arvo-tools/postgres-machine-memory';

const memory = await connectPostgresMachineMemory({
  version: 1,
  tables: {
    state: 'machine_memory_state',
    lock: 'machine_memory_lock',
    hierarchy: 'machine_memory_hierarchy'
  },
  config: {
    connectionString: 'postgresql://user:pass@localhost:5432/mydb'
  }
});

// Use the memory instance...

// Always release when done
await releasePostgressMachineMemory(memory);
```
