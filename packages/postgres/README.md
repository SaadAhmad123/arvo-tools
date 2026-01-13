# @arvo-tools/postgres

**PostgreSQL-backed infrastructure for building scalable, reliable event-driven workflow orchestration systems in the Arvo ecosystem.**

[![npm version](https://badge.fury.io/js/%40arvo-tools%2Fpostgres.svg)](https://www.npmjs.com/package/@arvo-tools/postgres)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

This package provides two core components for distributed event-driven orchestration for Arvo-based components in your application:

### PostgresEventBroker

- **Automatic Event Routing** - Routes ArvoEvents between handlers based on event destination
- **Persistent Queues** - PostgreSQL-backed job queues ensure no events are lost
- **Configurable Retry Logic** - Exponential backoff, retry limits, and dead letter queues
- **Workflow Completion Handling** - Register listeners for workflow completion events
- **Domained Event Support** - Handle special events requiring external interactions (human approvals, notifications)
- **OpenTelemetry Integration** - Distributed tracing across the entire event workflow
- **Queue Monitoring** - Built-in statistics for queue health and performance

### PostgresMachineMemory

- **Persistent State Storage** - Workflow instance data stored in PostgreSQL
- **Optimistic Locking** - Version counters prevent concurrent state modification conflicts
- **Distributed Locking** - TTL-based locks with automatic expiration prevent deadlocks
- **Hierarchical Workflows** - Track parent-child relationships for complex orchestrations
- **Automatic Cleanup** - Optional removal of completed workflow data
- **Connection Pooling** - Efficient database connection management
- **OpenTelemetry Support** - Optional instrumentation for observability

## Installation

This package is designed for Arvo-based components in your applications. To get the best value out of this package, you should use it in conjunction with [Arvo](https://www.arvo.land).

```bash
pnpm install @arvo-tools/postgres
```

## Requirements

- Node.js >= 22.12.0
- PostgreSQL database
- Required database tables (see [Database Setup](#database-setup))

## Database Setup

This package provides an abstraction layer on top of your PostgreSQL database so that the event handlers and orchestrators in Arvo can leverage the database to distribute events and persist their state for durable execution.

The `PostgresMachineMemory` requires tables to store and organize the state of the event handlers and orchestrators. The method `connectPostgresMachineMemory` discussed below automatically creates the required tables in your PostgreSQL database. However, if you are unable to provide it write permission, you can refer to the table schema documentation to deploy the tables manually:

- **[Version 1](./src/memory/v1/README.md)**


The `PostgresEventBroker` (built on PgBoss) will automatically create its required tables on first connection. You can view the [pg-boss documentation](https://timgit.github.io/pg-boss/#/) for its migration pattern.

## Usage

### PostgresMachineMemory

The orchestrators in Arvo, namely `ArvoOrchestrator` and `ArvoResumable`, require a memory backend to persist their state for distributed event-driven operations.

#### Basic Setup

```typescript
import {
  connectPostgresMachineMemory,
  releasePostgressMachineMemory
} from '@arvo-tools/postgres';
import {
  type IMachineMemory,
  type EventHandlerFactory,
  createArvoOrchestrator
} from 'arvo-event-handler';

// Establish a connection to postgres for machine memory operations
const memory = await connectPostgresMachineMemory({
  version: 1,
  config: {
    connectionString: process.env.POSTGRES_CONNECTION_STRING,
  }
  migrate: 'if_tables_dont_exist',
});

// Create an ArvoOrchestrator with the memory interface for dependency injection
const orchestratorHandler: EventHandlerFactory<{ memory: IMachineMemory }> = ({ memory }) => createArvoOrchestrator({
  // ... your orchestrator config
  memory: memory
});

const orchestrator = orchestratorHandler({memory})

// Always release when done
await releasePostgressMachineMemory(memory);
```


This example demonstrates connecting the PostgreSQL machine memory with a typical Arvo event handler (in this case `ArvoOrchestrator`). The `connectPostgresMachineMemory` takes in a `version` parameter to establish the table structure which will be used to persist the state. This allows for safe package versioning without requiring complex table migrations from your deployment. The table migrations will be rolled out based on this `version` while the implementation updates will be rolled out as per the package versions.

The `migrate` field provides a mechanism for you to configure the migration behavior. It tells the connection that if no tables are available, then create them before establishing the connection. By default this field is `'noop'` which results in no migration actions at all.

Once the memory has been defined and established, you can pass it to any Arvo event handler which is able to use it, and that's it.

#### Advanced Configuration

For production environments or specific use cases, you can configure the PostgreSQL machine memory with advanced settings including custom table names, connection pooling, distributed locking behavior, and observability features.

```typescript
const memory = await connectPostgresMachineMemory({
  version: 1,

  // Custom table names (optional)
  tables: {
    state: 'custom_state_table',
    lock: 'custom_lock_table',
    hierarchy: 'custom_hierarchy_table'
  },

  config: {
    // Connection via connection string
    connectionString: process.env.POSTGRES_CONNECTION_STRING,

    // OR via individual parameters
    // host: 'localhost',
    // port: 5432,
    // user: 'postgres',
    // password: 'postgres',
    // database: 'mydb',

    // Connection pool settings
    max: 20,                        // Maximum pool size (default: 10)
    idleTimeoutMillis: 30000,       // Idle client timeout (default: 30000)
    connectionTimeoutMillis: 5000,  // Connection acquisition timeout (default: 5000)
    statementTimeoutMillis: 30000,  // Statement execution timeout (optional)
    queryTimeoutMillis: 30000,      // Query execution timeout (optional)

    // Distributed lock configuration
    lockConfig: {
      maxRetries: 5,              // Lock acquisition retry attempts (default: 3)
      initialDelayMs: 50,         // Initial retry delay (default: 100)
      backoffExponent: 2,         // Exponential backoff multiplier (default: 1.5)
      ttlMs: 180000               // Lock TTL in milliseconds (default: 120000)
    },

    // Feature flags
    enableCleanup: true,          // Auto-cleanup completed workflows (default: false)
    enableOtel: true              // OpenTelemetry tracing (default: false)
  },

  // Migration strategy
  migrate: 'create_if_not_exists' // Options: 'noop' | 'create_if_not_exists' | 'dangerousely_force_migration'
});
```

**Migration Strategies:**

- **`'noop'` (default)** - No migration actions. Tables must already exist or connection will fail during validation.
- **`'create_if_not_exists'`** - Creates tables if they don't exist. Safe for production use.
- **`'dangerousely_force_migration'`** - Drops and recreates all tables, destroying existing data. Use only in development/testing environments.

**Lock Configuration:**

Configure lock behavior based on your workflow characteristics. Longer-running workflows need higher `ttlMs` values to prevent premature lock expiration. Increase `maxRetries` and adjust `backoffExponent` for high-contention scenarios where multiple processes compete for the same workflow locks. The defaults in Arvo and in this package are set which are appropriate for 95% of the usecases.

### PostgresEventBroker

Your PostgreSQL database can be further leveraged to establish a robust event broker for Arvo event handlers. Conceptually, each event handler you register gets its own dedicated task queue, providing isolated processing channels for different parts of your workflow. When an event is emitted in this broker, an intelligent event router inspects the `event.to` field and routes it to the appropriate handler's queue for processing. This ensures reliable, ordered delivery of events to their intended destinations.

This implementation utilizes `PgBoss` as the foundational job queue mechanism, providing battle-tested reliability, persistence, and retry capabilities. The `PostgresEventBroker` extends the `PgBoss` class to add Arvo-specific functionality such as automatic event routing, workflow completion handling, and domained event support. This design makes integration with your existing Arvo event handlers seamless and frictionless, requiring minimal code changes while gaining the benefits of PostgreSQL-backed reliability and scalability. 

#### Basic Setup

```typescript
import { PostgresEventBroker } from '@arvo-tools/postgres';
import { createArvoEventFactory } from 'arvo-core';

// Initialize broker
const broker = new PostgresEventBroker({
  connectionString: 'postgresql://user:password@localhost:5432/mydb'
});

await broker.start();

// Set up workflow completion handler
await broker.onWorkflowComplete({
  source: 'my.workflow',
  listener: async (event) => {
    console.log('Workflow completed:', event.data);
  },
  options: {
    worker: {
      concurrency: 5
    }
  }
});

// Register event handlers
await broker.register(myHandler, {
  recreateQueue: true,
  queue: {
    deadLetter: 'my_dlq'
  },
  worker: {
    concurrency: 10,
    retryLimit: 3,
    retryBackoff: true,
    pollingIntervalSeconds: 2
  }
});

// Dispatch events
const event = createArvoEventFactory(myContract.version('1.0.0')).accepts({
  source: 'my.workflow',
  data: { value: 42 }
});

await broker.dispatch(event);
```

#### Handler Registration with Retry Configuration

```typescript
await broker.register(calculatorHandler, {
  recreateQueue: true,
  queue: {
    policy: 'standard',
    deadLetter: 'calculator_dlq',
    warningQueueSize: 1000
  },
  worker: {
    concurrency: 5,
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 10,        // 10 seconds
    retryDelayMax: 300,    // 5 minutes max
    expireInSeconds: 900,  // 15 minutes timeout
    pollingIntervalSeconds: 2
  }
});
```

#### Handling Domained Events

```typescript
// Handle events that require external system interaction
broker.onDomainedEvent(async (event) => {
  if (event.domain === 'human.interaction') {
    await notificationService.send(event.data);
  } else if (event.domain === 'external.api') {
    await externalAPI.process(event.data);
  }
});
```

#### Custom Error Handling

```typescript
// Handle events with no registered destination
broker.onHandlerNotFound(async (event) => {
  logger.error('No handler found for event:', {
    eventType: event.type,
    destination: event.to,
    source: event.source
  });
  await alertingService.notify('Unrouted event detected');
});
```

#### Custom Logger

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'broker.log' })
  ]
});

broker.setLogger(logger);
```

#### Queue Monitoring

```typescript
// Get statistics for all queues
const stats = await broker.getStats();

stats.forEach(stat => {
  console.log(`Queue: ${stat.name}`);
  console.log(`  Active: ${stat.activeCount}`);
  console.log(`  Queued: ${stat.queuedCount}`);
  console.log(`  Total: ${stat.totalCount}`);
});
```

#### Cleanup

```typescript
// Stop broker and clean up resources
await broker.stop();
```


### Configuration Reference

#### PostgresEventBroker Options

Extends PgBoss configuration. See [PgBoss documentation](https://github.com/timgit/pg-boss) for full options.

```typescript
new PostgresEventBroker({
  connectionString: string,
  // ... or individual connection params
  host?: string,
  port?: number,
  database?: string,
  user?: string,
  password?: string,

  // PgBoss options
  schema?: string,
  max?: number,
  // ... see PgBoss docs for more
})
```

#### Handler Registration Options

```typescript
{
  recreateQueue?: boolean,  // Delete and recreate queue

  queue?: {
    policy?: 'standard' | 'short' | 'singleton' | 'stately',
    partition?: boolean,
    deadLetter?: string,
    warningQueueSize?: number
  },

  worker?: {
    // Worker config
    concurrency?: number,              // Number of workers (default: 1)
    pollingIntervalSeconds?: number,   // Polling interval (default: 2)

    // Job options
    priority?: number,
    retryLimit?: number,               // Number of retries (default: 2)
    retryDelay?: number,               // Delay between retries in seconds
    retryBackoff?: boolean,            // Exponential backoff (default: false)
    retryDelayMax?: number,            // Max delay for backoff
    expireInSeconds?: number,          // Job timeout (default: 15 min)
    retentionSeconds?: number,         // How long to keep jobs (default: 14 days)
    deleteAfterSeconds?: number,       // Delete after completion (default: 7 days)
    startAfter?: number | string | Date, // Delay job start
    singletonSeconds?: number,         // Throttle to one job per interval
    singletonNextSlot?: boolean,
    singletonKey?: string
  }
}
```

## API Reference

### PostgresEventBroker

#### Methods

- `start()` - Start the broker
- `stop()` - Stop the broker and clean up resources
- `register(handler, options?)` - Register an event handler
- `onWorkflowComplete({ source, listener, options? })` - Register workflow completion handler
- `dispatch(event)` - Dispatch an event into the system
- `onHandlerNotFound(listener)` - Handle unroutable events
- `onDomainedEvent(listener)` - Handle domained events
- `setLogger(logger)` - Set custom logger
- `getStats()` - Get queue statistics
- `queues` - Get array of registered queue names

### PostgresMachineMemory

#### Methods

- `read(id)` - Read workflow state
- `write(id, data, prevData, metadata)` - Write workflow state with optimistic locking
- `lock(id)` - Acquire distributed lock
- `unlock(id)` - Release distributed lock
- `cleanup(id)` - Remove workflow data
- `getSubjectsByRoot(rootSubject)` - Get all child workflow subjects
- `getRootSubject(subject)` - Get root workflow subject
- `close()` - Close connection pool
- `validateTableStructure()` - Validate database schema

### Factory Functions

- `connectPostgresMachineMemory(params)` - Create and validate machine memory instance
- `releasePostgressMachineMemory(memory)` - Release machine memory resources

## Troubleshooting

### "Table does not exist" errors

Ensure all three tables are created before connecting. Run the factory function with \`migrate\` parameter, SQL schema, or Prisma migration.

### Events not being processed

- Check that handlers are registered: `broker.queues`
- Verify workflow completion handler is set up
- Check queue statistics: `await broker.getStats()`
- Review logs for routing errors

### Lock acquisition failures

- Increase `maxRetries` or `ttlMs`
- Check for deadlocks in application logic
- Monitor lock table for expired locks not being cleaned up

### Memory leaks

- Always call `broker.stop()` and `releasePostgressMachineMemory()`

## Contributing

Contributions are welcome! Please see the [main repository](https://github.com/SaadAhmad123/arvo-tools) for contribution guidelines.

## Links

- [GitHub Repository](https://github.com/SaadAhmad123/arvo-tools)
- [Arvo Documentation](https://www.arvo.land)
- [PgBoss Documentation](https://github.com/timgit/pg-boss)
- [Issue Tracker](https://github.com/SaadAhmad123/arvo-tools/issues)

## Support

For questions and support:
- Open an issue on [GitHub](https://github.com/SaadAhmad123/arvo-tools/issues)
- Check the [Arvo documentation](https://www.arvo.land)

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and changes.
