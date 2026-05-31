import { describe, expect, it } from 'vitest';
import { ArvoHandlerTool, type ArvoHandlerToolResult, JsonResultData } from '../../src';
import {
  addArvoTool,
  addContractV1,
  addEventFactory,
  userCreateArvoTool,
  userCreateEventFactoryV1,
} from './fixtures';

describe('ArvoHandlerTool', () => {
  describe('has()', () => {
    it('returns true for the contract type', () => {
      expect(addArvoTool.has('com.calculator.add')).toBe(true);
    });

    it('returns false for a different name', () => {
      expect(addArvoTool.has('com.something.else')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(addArvoTool.has('')).toBe(false);
    });
  });

  describe('metadata()', () => {
    it('is keyed by the contract type', () => {
      const meta = addArvoTool.metadata();
      expect(meta['com.calculator.add']).toBeDefined();
    });

    it('sets name to the contract type', () => {
      const meta = addArvoTool.metadata();
      expect(meta['com.calculator.add']?.name).toBe('com.calculator.add');
    });

    it('uses the contract description', () => {
      const meta = addArvoTool.metadata();
      expect(meta['com.calculator.add']?.description).toBe('Adds numbers together');
    });

    it('includes an inputSchema', () => {
      const meta = addArvoTool.metadata();
      expect(meta['com.calculator.add']?.inputSchema).toBeDefined();
    });

    it('strips $schema from inputSchema', () => {
      const meta = addArvoTool.metadata();
      expect(meta['com.calculator.add']?.inputSchema.$schema).toBeUndefined();
    });

    it('inputSchema reflects the accepts schema shape', () => {
      const meta = addArvoTool.metadata();
      const schema = meta['com.calculator.add']?.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
    });
  });

  describe('execute()', () => {
    it('returns an external_call result for a valid dispatch', async () => {
      const results = await addArvoTool.execute([
        { id: 'call-1', name: 'com.calculator.add', args: { numbers: [1, 2, 3] } },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('external_call');
    });

    it('external_call body contains contract metadata and validated data', async () => {
      const results = await addArvoTool.execute([
        { id: 'call-1', name: 'com.calculator.add', args: { numbers: [4, 5] } },
      ]);
      const body = (await results[0]?.body()) as Record<string, unknown>;
      expect(body.contractType).toBe('com.calculator.add');
      expect(body.contractUri).toBe('#/test/calculator/add');
      expect(body.contractVersion).toBe('1.0.0');
      expect(body.dataschema).toBe('#/test/calculator/add/1.0.0');
      expect(body.data).toEqual({ numbers: [4, 5] });
    });

    it('result id matches the dispatch id', async () => {
      const results = await addArvoTool.execute([
        { id: 'my-dispatch-id', name: 'com.calculator.add', args: { numbers: [1] } },
      ]);
      expect((results[0] as ArvoHandlerToolResult).id).toBe('my-dispatch-id');
    });

    it('returns an error result when args fail schema validation', async () => {
      const results = await addArvoTool.execute([
        { id: 'call-1', name: 'com.calculator.add', args: { numbers: ['not-a-number'] } },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('error');
    });

    it('filters out dispatches with a mismatched name', async () => {
      const results = await addArvoTool.execute([
        { id: 'call-1', name: 'com.something.else', args: { numbers: [1] } },
      ]);
      expect(results).toHaveLength(0);
    });

    it('returns empty array when all dispatches have mismatched names', async () => {
      const results = await addArvoTool.execute([
        { id: 'call-1', name: 'wrong', args: {} },
        { id: 'call-2', name: 'also-wrong', args: {} },
      ]);
      expect(results).toHaveLength(0);
    });

    it('handles multiple valid dispatches and preserves order', async () => {
      const results = await addArvoTool.execute([
        { id: 'call-1', name: 'com.calculator.add', args: { numbers: [1, 2] } },
        { id: 'call-2', name: 'com.calculator.add', args: { numbers: [3, 4] } },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('external_call');
      expect(results[1]?.type).toBe('external_call');
      expect((results[0] as ArvoHandlerToolResult).id).toBe('call-1');
      expect((results[1] as ArvoHandlerToolResult).id).toBe('call-2');
    });

    it('handles mixed valid and invalid dispatches', async () => {
      const results = await addArvoTool.execute([
        { id: 'call-1', name: 'com.calculator.add', args: { numbers: [1, 2] } },
        { id: 'call-2', name: 'com.calculator.add', args: { numbers: 'bad-input' } },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('external_call');
      expect(results[1]?.type).toBe('error');
    });

    it('returns empty array for an empty dispatch list', async () => {
      const results = await addArvoTool.execute([]);
      expect(results).toHaveLength(0);
    });
  });

  describe('onExternalResponse()', () => {
    async function getCall(dispatchId = 'call-1') {
      const dispatch = { id: dispatchId, name: 'com.calculator.add', args: { numbers: [1, 2] } };
      const results = await addArvoTool.execute([dispatch]);
      return { dispatch, request: results[0] as ArvoHandlerToolResult };
    }

    it('returns a json result for a valid emit event', async () => {
      const { dispatch, request } = await getCall();
      const response = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: 'com.calculator.add',
          data: { result: 3 },
        })
        .toJSON();

      const results = await addArvoTool.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
    });

    it('result body contains the event data', async () => {
      const { dispatch, request } = await getCall();
      const response = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: 'com.calculator.add',
          data: { result: 42 },
        })
        .toJSON();

      const results = await addArvoTool.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );
      expect(await results[0]?.body()).toEqual({ result: 42 });
    });

    it('result id matches the request id', async () => {
      const { dispatch, request } = await getCall('my-call');
      const response = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: 'com.calculator.add',
          data: { result: 3 },
        })
        .toJSON();

      const results = await addArvoTool.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );
      expect(results[0]?.id).toBe('my-call');
    });

    it('returns a json result for a system error event', async () => {
      const { dispatch, request } = await getCall();
      const response = addEventFactory
        .systemError({ source: 'com.calculator.add', error: new Error('Handler failed') })
        .toJSON();

      const results = await addArvoTool.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
    });

    it('returns an error result for an unrecognized event type', async () => {
      const { dispatch, request } = await getCall();
      const validEvent = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: 'com.calculator.add',
          data: { result: 3 },
        })
        .toJSON();
      const response = { ...validEvent, type: 'evt.unexpected.type' };

      const results = await addArvoTool.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('error');
    });

    it('returns an error result for a completely malformed response', async () => {
      const { dispatch, request } = await getCall();
      const results = await addArvoTool.onExternalResponse(dispatch, request, {
        completely: 'invalid',
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('error');
    });

    it('invokes the custom onResponse callback and returns its result', async () => {
      const userDispatch = {
        id: 'user-call',
        name: 'com.user.create',
        args: { name: 'Alice', age: 30 },
      };
      const userResults = await userCreateArvoTool.execute([userDispatch]);
      const userRequest = userResults[0] as ArvoHandlerToolResult;

      const response = userCreateEventFactoryV1
        .emits({
          type: 'evt.user.create.success',
          source: 'com.user.create',
          data: { created: true },
        })
        .toJSON();

      const results = await userCreateArvoTool.onExternalResponse(
        userDispatch,
        userRequest,
        response as Record<string, unknown>,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as Record<string, unknown>;
      expect(body.processed).toBe(true);
      expect(body.created).toBe(true);
    });

    it('passes dispatch, request, and response to the custom onResponse callback', async () => {
      const capturedOptions: Record<string, unknown>[] = [];

      const capturingTool = new ArvoHandlerTool({
        contract: addContractV1,
        onResponse: async (_event, options) => {
          capturedOptions.push(options as Record<string, unknown>);
          return [new JsonResultData('captured', {})];
        },
      });

      const dispatch = { id: 'cap-call', name: 'com.calculator.add', args: { numbers: [1] } };
      const [execResult] = await capturingTool.execute([dispatch]);
      const request = execResult as ArvoHandlerToolResult;
      const response = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: 'com.calculator.add',
          data: { result: 1 },
        })
        .toJSON();

      await capturingTool.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );

      expect(capturedOptions[0]).toMatchObject({
        dispatch,
        request,
        response,
      });
    });
  });
});
