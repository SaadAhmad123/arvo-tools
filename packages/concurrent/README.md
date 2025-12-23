# @arvo-tools/concurrent

**Official Concurrent in-process infrastructure for Arvo applications.**

[![npm version](https://badge.fury.io/js/%40arvo-tools%2Fconcurrent.svg)](https://www.npmjs.com/package/@arvo-tools/concurrent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)


## Overview

Arvo handlers process events asynchronously. When multiple events arrive for different handlers, they can all be processed concurrently as async operations (unless there are CPU bound tasks). The challenge emerges when these concurrent operations need coordination—multiple handlers accessing the same workflow state create race conditions where overlapping async operations corrupt data. Handlers that crash while holding locks leave workflows permanently blocked. Different handlers have different optimal concurrency levels—some should process many events simultaneously while others need stricter limits to prevent resource exhaustion.

This package provides the concurrent infrastructure layer for Arvo applications. It solves state coordination through atomic locking with automatic expiration and enables optimal throughput through per-handler concurrency control in the event loop.

## Installation

```bash
npm install @arvo-tools/concurrent
```

See [arvo.land](https://arvo.land) for Arvo setup.


## Deployment Context

This package is designed for single-process Arvo applications where multiple handlers process events concurrently through the Node.js event loop. All state and queues exist in-memory within the process.

For distributed deployments across multiple processes or containers requiring shared state, implement custom `IMachineMemory` backends using Redis, PostgreSQL, DynamoDB, or similar distributed storage systems that provide state persistence and coordination across process boundaries.


## The Concurrent Memory Backend

`ConcurrentMachineMemory` is the concurrency-safe, single process, in-memory implementation of Arvo's `IMachineMemory` interface, which all orchestrators and resumables require for workflow state persistence and coordination. This interface defines how workflow state is stored, retrieved, and synchronized across concurrent handler executions.

When multiple handlers process events concurrently through the event loop, their async operations can overlap in time. Consider two handlers processing different events for the same workflow instance—both read the current state, perform their operations, and attempt to write updated state back. Without proper synchronization, their operations interleave unpredictably. Handler A reads state, Handler B reads the same state, Handler A writes its changes, then Handler B writes its changes based on the now-stale state it read earlier. Handler B's write overwrites Handler A's changes, corrupting the workflow state. This race condition occurs even in single-threaded JavaScript because async operations don't execute atomically.

The built-in lock implementation prevents this corruption. Before a handler can read or modify workflow state, it acquires an exclusive lock for that workflow instance, which it obtain async atomically. Other handlers attempting to access the same workflow state must wait until the lock releases. This ensures only one handler modifies state at any given time, maintaining consistency.

The built-in lock expiration solves the deadlock problem. If a handler acquires a lock but crashes before releasing it, that lock would block the workflow permanently. TTL-based expiration automatically releases locks after a configured duration, allowing other handlers to resume the workflow even after crashes. The retry mechanism with exponential backoff handles lock contention gracefully—when multiple handlers compete for the same lock, they space their attempts progressively to reduce contention storms.

### Usage

**Basic Setup**

```typescript
import { ConcurrentMachineMemory } from '@arvo-tools/concurrent';

const memory = new ConcurrentMachineMemory();
```

**Production Configuration**

```typescript
const memory = new ConcurrentMachineMemory({
  lockMaxRetries: 5,           // Retry attempts before failing
  lockInitialDelayMs: 50,      // Initial retry delay
  lockBackoffExponent: 2,      // Delay growth between retries
  lockTTLMs: 300000,           // Lock expiration (5 minutes)
  enableCleanup: true          // Remove completed workflow state
});
```

**With Orchestrators**

```typescript
import { createArvoOrchestrator, IMachineMemory } from 'arvo-event-handler';

const orchestrator: EventHandlerFactory<{ memory: IMachineMemory }> = ({ memory }) => 
    createArvoOrchestrator({
        memory,
        machines: [workflowMachine]
    });

orchestrator({ memory })

```

**With Resumables**

```typescript
import { createArvoResumable } from 'arvo-event-handler';

const resumable: EventHandlerFactory<{ memory: IMachineMemory }> = ({ memory }) => createArvoResumable({
  memory,
  contracts: { self: myContract, services: {...} },
  handler: { '1.0.0': async ({ input, context }) => {...} }
});

resumable({ memory })
```

## The Concurrent Event Broker

`ConcurrentEventBroker` is the concurrent event routing implementation for Arvo, providing per-handler concurrency control through independent queue management. It routes events to registered handlers while controlling how many events each handler processes concurrently.

A broker processing events sequentially through handlers leaves the system underutilized when handlers are I/O-bound. Consider a handler making API calls that take 500ms to respond—while waiting for the API response, the handler sits idle in the event loop even though it could be processing other events concurrently. Sequential processing means only one API call happens at a time, wasting the handler's capacity to manage multiple in-flight requests simultaneously. This problem compounds when multiple I/O-bound handlers exist—Handler A waits for its API response while Handler B waits to start processing events it could already be handling concurrently.

Conversely, allowing unlimited concurrent processing overwhelms system resources. If a handler receives 100 events and processes all concurrently, it creates 100 simultaneous database connections or API requests, exhausting connection pools and triggering rate limits.

Per-handler prefetch limits solve both problems. Handler A configured with prefetch 10 maintains up to 10 concurrent API calls—when one completes, it immediately starts the next queued event. Handler B limited to prefetch 3 processes only 3 events concurrently, respecting its tighter resource constraints. Each handler operates at its optimal concurrency level independently. When events arrive for both handlers, Handler A processes 10 concurrently while Handler B processes 3 concurrently, all through the same event loop without blocking each other.

The broker implements retry logic with exponential backoff for handling transient failures. When a handler throws an error, the broker can retry the event with progressively longer delays between attempts. Middleware hooks enable observability by intercepting events before and after handler execution. Domain-based routing routes events to external systems outside the standard broker flow, enabling integration with human interfaces or third-party services.

### Usage

**Basic Setup**

```typescript
import { createConcurrentEventBroker } from '@arvo-tools/concurrent';

const { broker, resolve } = createConcurrentEventBroker([
  { handler: myHandler() },
  { handler: anotherHandler() }
]);
```

**Per-Handler Concurrency Control**

```typescript
const { broker, resolve } = createConcurrentEventBroker([
  { handler: databaseHandler(), prefetch: 3 },         // Limit db connections
  { handler: externalApiHandler(), prefetch: 10 },     // Higher for API calls
  { handler: orchestrator({ memory }), prefetch: 5 },  // Moderate concurrency
  { handler: lightweightHandler(), prefetch: 20 }      // High for simple ops
]);
```

**Retry Configuration**

```typescript
const { broker, resolve } = createConcurrentEventBroker(
  [
    { 
      handler: unreliableServiceHandler(),
      prefetch: 8,
      retry: {
        maxRetries: 5,
        initialDelayMs: 200,
        backoffExponent: 2
      },
      onError: (error, config) => {
        if (error.message.includes('rate limit')) return 'RETRY';
        if (error.message.includes('invalid')) return 'THROW';
        return 'SUPPRESS';
      }
    }
  ],
  {
    defaultHandlerConfig: {
      retry: { maxRetries: 3, initialDelayMs: 100 }
    }
  }
);
```

**Middleware for Observability & Security**

```typescript
const { broker, resolve } = createConcurrentEventBroker(
  [
    {
      handler: myHandler(),
      middleware: {
        input: async (event) => {
          logger.info('Processing', { type: event.type, id: event.id });
          return event;
        },
        output: [
            async ({ input, output }) => {
                metrics.increment('events.produced', output.type);
            },
            async ({ input, output }) => {
                if (input.accesscontrol !== output.accesscontrol) {
                    throw new Error("Access control tampering detected")
                }
            },
            async ({ input, output }) => {
                if (input.id !== output.parent) {
                    throw new Error("Invalid event lineage detected")
                }
            },
        ]
      }
    }
  ]
);
```

**Domain Event Routing**

```typescript
const domainedEvents: ArvoEvent[] = [];
const { broker, resolve } = createConcurrentEventBroker([...], {
  onDomainedEvents: async ({ event }) => {
    domainedEvents.push(event);
  }
});
```

**Workflow Execution**

```typescript
const initialEvent = createArvoEventFactory(contract.version('1.0.0'))
  .accepts({
    source: 'client',
    data: { input: 'value' }
  });

const finalEvent = await resolve(initialEvent);
```

## A Complete Application Pattern

The concurrent broker processes events through handlers until reaching terminal states. Complex workflows often span multiple broker invocations where intermediate events require external processing before continuing. The event loop pattern handles this by checking returned events, routing specific types outside the broker for external processing, then feeding responses back through the broker to continue the workflow.

**Setting Up the Broker and Event Loop**

The `executeHandlers` function encapsulates broker setup and event resolution. Multiple handlers register with independent prefetch limits based on their resource characteristics. The `onDomainedEvents` callback captures events that route outside standard broker flow, accumulating them for external processing. The `resolve` function processes the event through registered handlers until no more work remains, returning both the final event and any captured domain events.

```typescript
import { ConcurrentMachineMemory, createConcurrentEventBroker } from '@arvo-tools/concurrent';
import { ArvoEvent } from 'arvo-core';

const memory = new ConcurrentMachineMemory();

const executeHandlers = async (event: ArvoEvent): Promise<ArvoEvent[]> => {
  const domainedEvents: ArvoEvent[] = [];
  
  const response = await createConcurrentEventBroker([
    { handler: handlerA({ memory }), prefetch: 5 },
    { handler: handlerB({ memory }), prefetch: 3 },
    { handler: handlerC(), prefetch: 10 },
    { handler: orchestrator({ memory }), prefetch: 2 },
  ], {
    defaultHandlerConfig: { prefetch: 1 },
    onDomainedEvents: async ({ event }) => {
      domainedEvents.push(event);
    },
  }).resolve(event);
  
  return response ? [response, ...domainedEvents] : domainedEvents;
};
```

**Processing Events Across Multiple Broker Invocations**

The event loop processes events through handlers repeatedly, checking for events requiring external processing between invocations. When specific event types appear, they route to external processors that generate response events. Those responses feed back through the broker via `executeHandlers`, continuing the workflow. The loop terminates when no events require external processing, indicating workflow completion.

```typescript
async function main() {
  let eventToProcess: ArvoEvent = createInitialEvent();
  let events: ArvoEvent[] = [];
  
  while (true) {
    const response = await executeHandlers(eventToProcess);
    events = response.length ? response : events;

    // Check for events requiring external processing
    const externalEventIndex = events.findIndex(
      (item) => item.type === 'com.external.request'
    );
    if (externalEventIndex !== -1) {
      eventToProcess = await processExternally(events[externalEventIndex]);
      events.splice(externalEventIndex, 1);
      continue;
    }

    const anotherExternalEventIndex = events.findIndex(
      (item) => item.type === 'com.another.external'
    );
    if (anotherExternalEventIndex !== -1) {
      eventToProcess = await handleExternally(events[anotherExternalEventIndex]);
      events.splice(anotherExternalEventIndex, 1);
      continue;
    }

    const thirdExternalEventIndex = events.findIndex(
      (item) => item.type === 'com.third.external'
    );
    if (thirdExternalEventIndex !== -1) {
      eventToProcess = await processViaThirdParty(events[thirdExternalEventIndex]);
      events.splice(thirdExternalEventIndex, 1);
      continue;
    }

    // No events require external processing, workflow complete
    break;
  }
  
  console.log('Final events:', events);
}
```

This pattern enables workflows spanning arbitrary durations and external system boundaries. Handlers emit events during processing, the broker resolves what it can, and control returns to the event loop. External processors generate responses at their own pace—milliseconds for API calls, hours for human approvals, days for batch processes—then responses feed back through the broker to resume workflows exactly where they suspended.

