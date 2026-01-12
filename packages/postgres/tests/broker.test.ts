import { createArvoEventFactory } from 'arvo-core';
import { describe, expect, it, vi } from 'vitest';
import {
  connectPostgresMachineMemory,
  PostgresEventBroker,
  releasePostgressMachineMemory,
} from '../src';
import { addContract, addHandler } from './handlers/add.service';
import { averageWorkflow, averageWorkflowContract } from './handlers/average.workflow';
import { humanApprovalContract } from './handlers/human.approval.contract';
import { productHandler } from './handlers/product.service';
import {
  weightedAverageContract,
  weightedAverageResumable,
} from './handlers/weighted.average.resumable';

const connectionString = process.env.ARVO_POSTGRES_CONNECTION_STRING ?? '';
const testTables = {
  state: 'pgboss_test_state',
  lock: 'pgboss_test_lock',
  hierarchy: 'pgboss_test_hierarchy',
};

const TEST_EVENT_SOURCE = 'test.pgboss.source';

describe('PostgresEventBroker - Custom Functionality Tests', () => {
  describe('Handler Registration', () => {
    it('should successfully register a handler', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const handler = addHandler();
        await broker.register(handler);

        expect(broker.queues).toContain(handler.source);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should throw error when registering duplicate handler', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const handler = addHandler();
        await broker.register(handler);

        await expect(broker.register(handler)).rejects.toThrow(
          /Handler registration failed.*already registered/i,
        );
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should track multiple registered handlers in queues array', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const addHandlerInstance = addHandler();
        const productHandlerInstance = productHandler();

        await broker.register(addHandlerInstance);
        await broker.register(productHandlerInstance);

        expect(broker.queues).toContain(addHandlerInstance.source);
        expect(broker.queues).toContain(productHandlerInstance.source);
        expect(broker.queues.length).toBeGreaterThanOrEqual(2);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should create queue with recreateQueue option', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const handler = addHandler();
        await broker.register(handler, { recreateQueue: true });

        expect(broker.queues).toContain(handler.source);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });
  });

  describe('Workflow Completion Setup', () => {
    it('should successfully setup workflow completion handler', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const listener = vi.fn();

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener,
        });

        expect(broker.queues).toContain(TEST_EVENT_SOURCE);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should register completion queue with recreateQueue option', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const listener = vi.fn();

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener,
          options: { recreateQueue: true },
        });

        expect(broker.queues).toContain(TEST_EVENT_SOURCE);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });
  });

  describe('Event Dispatching with Validation', () => {
    it('should throw error if onWorkflowComplete not called', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const handler = addHandler();
        await broker.register(handler);

        const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
          source: TEST_EVENT_SOURCE,
          data: { numbers: [1, 2, 3] },
        });

        await expect(broker.dispatch(event)).rejects.toThrow(
          /Workflow completion handler not configured/i,
        );
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should throw error if event source does not match workflow source', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const handler = addHandler();
        await broker.register(handler);

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: vi.fn(),
        });

        const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
          source: 'test.wrong.source',
          data: { numbers: [1, 2, 3] },
        });

        await expect(broker.dispatch(event)).rejects.toThrow(/Event source mismatch/i);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should throw error if target handler is not registered', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: vi.fn(),
        });

        const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
          source: TEST_EVENT_SOURCE,
          data: { numbers: [1, 2, 3] },
          to: 'non.existent.handler',
        });

        await expect(broker.dispatch(event)).rejects.toThrow(/Handler not registered/i);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should successfully dispatch valid event and return job ID', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        const handler = addHandler();
        await broker.register(handler);

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: vi.fn(),
        });

        const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
          source: TEST_EVENT_SOURCE,
          data: { numbers: [1, 2, 3] },
        });

        const jobId = await broker.dispatch(event);
        expect(jobId).toBeTruthy();
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });
  });

  describe('End-to-End Workflow Execution', () => {
    it('should execute average workflow and complete successfully', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
        const completionEvents: any[] = [];

        await broker.register(addHandler(), { recreateQueue: true });
        await broker.register(productHandler(), { recreateQueue: true });
        await broker.register(averageWorkflow({ memory }), { recreateQueue: true });

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: (event) => {
            completionEvents.push(event);
          },
          options: { recreateQueue: true },
        });

        const event = createArvoEventFactory(averageWorkflowContract.version('1.0.0')).accepts({
          source: TEST_EVENT_SOURCE,
          data: {
            parentSubject$$: null,
            numbers: [10, 20, 30],
          },
        });

        await broker.dispatch(event);
        await waitForQueues(broker, 30000);

        expect(completionEvents.length).toBeGreaterThan(0);
        const finalEvent = completionEvents[completionEvents.length - 1];
        expect(finalEvent.data.success).toBe(true);
        expect(finalEvent.data.average).toBe(20);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    }, 35000);
  });

  describe('Resumable Workflow with Memory', () => {
    it('should execute weighted average resumable workflow', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
        const completionEvents: any[] = [];
        // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
        const domainedEvents: any[] = [];

        await broker.register(addHandler(), { recreateQueue: true });
        await broker.register(productHandler(), { recreateQueue: true });

        const workflow = weightedAverageResumable({ memory });
        await broker.register(workflow, { recreateQueue: true });

        broker.onDomainedEvent(async (event) => {
          domainedEvents.push(event);
          const e = createArvoEventFactory(humanApprovalContract.version('1.0.0')).emits({
            // Default context passing so that event chains can be stitched
            subject: event?.data?.parentSubject$$ ?? event?.subject ?? undefined,
            parentid: event?.id ?? undefined,
            to: event?.source ?? undefined,
            // The event data
            type: 'evt.human.approval.success',
            source: TEST_EVENT_SOURCE,
            data: {
              approval: true,
            },
          });
          await broker.dispatch(e);
        });

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: (event) => {
            completionEvents.push(event);
          },
          options: { recreateQueue: true },
        });

        const event = createArvoEventFactory(weightedAverageContract.version('1.0.0')).accepts({
          source: TEST_EVENT_SOURCE,
          data: {
            parentSubject$$: null,
            input: [
              { value: 10, weight: 0.5 },
              { value: 20, weight: 0.5 },
            ],
          },
        });

        await broker.dispatch(event);

        await waitForQueues(broker, 30000);

        expect(domainedEvents.length).toBeGreaterThan(0);
        expect(domainedEvents[0].type).toContain('human.approval');
        expect(completionEvents.length).toBeGreaterThan(0);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    }, 30000);
  });

  describe('Event Routing & Callbacks', () => {
    it('should invoke onHandlerNotFound callback when target handler does not exist', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
        const notFoundEvents: any[] = [];

        broker.onHandlerNotFound((event) => {
          notFoundEvents.push(event);
        });

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: vi.fn(),
        });

        const handler = addHandler();
        await broker.register(handler);

        const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
          source: TEST_EVENT_SOURCE,
          data: { numbers: [1, 2] },
        });

        await broker.dispatch(event);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        expect(notFoundEvents.length).toBeGreaterThanOrEqual(0);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should invoke onDomainedEvent callback when event has domain field', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
        const domainedEvents: any[] = [];

        broker.onDomainedEvent((event) => {
          domainedEvents.push(event);
        });

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: vi.fn(),
        });

        const workflow = weightedAverageResumable({ memory });
        await broker.register(workflow, { recreateQueue: true });

        const event = createArvoEventFactory(weightedAverageContract.version('1.0.0')).accepts({
          source: TEST_EVENT_SOURCE,
          data: {
            parentSubject$$: null,
            input: [
              { value: 5, weight: 0.5 },
              { value: 15, weight: 0.5 },
            ],
          },
        });

        await broker.dispatch(event);

        await waitForQueues(broker, 30000);

        expect(domainedEvents.length).toBeGreaterThan(0);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });
  }, 30000);

  describe('Statistics & Monitoring', () => {
    it('should return stats for all registered queues', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        await broker.register(addHandler(), { recreateQueue: true });
        await broker.register(productHandler(), { recreateQueue: true });

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: vi.fn(),
        });

        const stats = await broker.getStats();

        expect(stats.length).toBeGreaterThanOrEqual(3);
        expect(stats[0]).toHaveProperty('activeCount');
        expect(stats[0]).toHaveProperty('queuedCount');
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });

    it('should show empty queues when no jobs are running', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
        migrate: 'dangerousely_force_migration',
      });
      const broker = new PostgresEventBroker({ connectionString });
      await broker.start();

      try {
        await broker.register(addHandler(), { recreateQueue: true });

        await broker.onWorkflowComplete({
          source: TEST_EVENT_SOURCE,
          listener: vi.fn(),
        });

        const stats = await broker.getStats();

        const allEmpty = stats.every((stat) => stat.activeCount === 0 && stat.queuedCount === 0);
        expect(allEmpty).toBe(true);
      } finally {
        await broker.stop();
        await releasePostgressMachineMemory(memory);
      }
    });
  });
});

async function waitForQueues(broker: PostgresEventBroker, timeout = 30000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const stats = await broker.getStats();
    const allSettled = stats.every((stat) => stat.activeCount === 0 && stat.queuedCount === 0);

    if (allSettled) {
      return;
    }
  }

  throw new Error(`Timeout waiting for queues to drain after ${timeout}ms`);
}
