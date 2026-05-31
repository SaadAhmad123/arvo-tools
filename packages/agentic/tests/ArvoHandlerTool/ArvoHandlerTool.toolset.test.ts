import { describe, expect, it } from 'vitest';
import { type ArvoHandlerToolResult, type ToolNotExist, Toolset } from '../../src';
import { addTool, greetTool } from '../FunctionTool/tools';
import {
  addArvoTool,
  addEventFactory,
  userCreateArvoTool,
  userCreateEventFactoryV1,
} from './fixtures';

describe('ArvoHandlerTool in Toolset', () => {
  describe('metadata()', () => {
    it('returns empty object before init', () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      expect(toolset.metadata()).toEqual({});
    });

    it('exposes compound key after init', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      expect(toolset.metadata()['arvo>com.calculator.add']).toBeDefined();
      await toolset.close();
    });

    it('compound key name matches the index key', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      expect(toolset.metadata()['arvo>com.calculator.add']?.name).toBe('arvo>com.calculator.add');
      await toolset.close();
    });

    it('indexes ArvoHandlerTool and FunctionTool together', async () => {
      const toolset = new Toolset({ arvo: addArvoTool, fn: addTool });
      await toolset.init();
      const meta = toolset.metadata();
      expect(meta['arvo>com.calculator.add']).toBeDefined();
      expect(meta['fn>add']).toBeDefined();
      await toolset.close();
    });

    it('ArvoHandlerTool metadata includes inputSchema', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      expect(toolset.metadata()['arvo>com.calculator.add']?.inputSchema).toBeDefined();
      await toolset.close();
    });
  });

  describe('has()', () => {
    it('returns true for a registered ArvoHandlerTool compound key', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      expect(toolset.has('arvo>com.calculator.add')).toBe(true);
      await toolset.close();
    });

    it('returns false for the bare contract type (not a compound key)', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      expect(toolset.has('com.calculator.add')).toBe(false);
      await toolset.close();
    });

    it('returns false for an unknown compound key', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      expect(toolset.has('arvo>com.unknown.tool')).toBe(false);
      await toolset.close();
    });
  });

  describe('execute()', () => {
    it('routes an ArvoHandlerTool dispatch and returns external_call', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'arvo>com.calculator.add', args: { numbers: [1, 2] } },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('external_call');
      await toolset.close();
    });

    it('external_call body has correct contract metadata', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'arvo>com.calculator.add', args: { numbers: [10, 20] } },
      ]);
      const body = (await results[0]?.body()) as Record<string, unknown>;
      expect(body.contractType).toBe('com.calculator.add');
      expect(body.contractVersion).toBe('1.0.0');
      expect(body.data).toEqual({ numbers: [10, 20] });
      await toolset.close();
    });

    it('routes a FunctionTool dispatch and returns json', async () => {
      const toolset = new Toolset({ arvo: addArvoTool, fn: addTool });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'fn>add', args: { a: 3, b: 7 } }]);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ sum: 10 });
      await toolset.close();
    });

    it('handles mixed ArvoHandlerTool and FunctionTool dispatches in one call', async () => {
      const toolset = new Toolset({ arvo: addArvoTool, fn: greetTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'fn>greet', args: { name: 'Alice' } },
        { id: '2', name: 'arvo>com.calculator.add', args: { numbers: [5, 5] } },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ message: 'Hello, Alice!' });
      expect(results[1]?.type).toBe('external_call');
      await toolset.close();
    });

    it('returns tool_not_exist for an unknown compound key', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'arvo>com.unknown.tool', args: {} }]);
      expect(results[0]?.type).toBe('tool_not_exist');
      await toolset.close();
    });

    it('handles multiple ArvoHandlerTool dispatches in one call', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'arvo>com.calculator.add', args: { numbers: [1] } },
        { id: '2', name: 'arvo>com.calculator.add', args: { numbers: [2, 3] } },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('external_call');
      expect(results[1]?.type).toBe('external_call');
      expect((results[0] as ArvoHandlerToolResult).id).toBe('1');
      expect((results[1] as ArvoHandlerToolResult).id).toBe('2');
      await toolset.close();
    });

    it('invalid args for ArvoHandlerTool return error through Toolset', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'arvo>com.calculator.add', args: { numbers: 'not-an-array' } },
      ]);
      expect(results[0]?.type).toBe('error');
      await toolset.close();
    });
  });

  describe('onExternalResponse()', () => {
    it('routes an external response back through the ArvoHandlerTool and returns json', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();

      const dispatch = { id: 'call-1', name: 'arvo>com.calculator.add', args: { numbers: [2, 3] } };
      const execResults = await toolset.execute([dispatch]);
      const request = execResults[0] as ArvoHandlerToolResult;

      const response = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: 'com.calculator.add',
          data: { result: 5 },
        })
        .toJSON();

      const results = await toolset.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ result: 5 });
      await toolset.close();
    });

    it('returns tool_not_exist when compound key is not in the index', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();

      const dispatch = { id: 'call-1', name: 'arvo>com.calculator.add', args: { numbers: [1, 2] } };
      const execResults = await toolset.execute([dispatch]);
      const request = execResults[0] as ArvoHandlerToolResult;

      const unknownDispatch = { ...dispatch, name: 'arvo>com.unknown.tool' };
      const results = await toolset.onExternalResponse(unknownDispatch, request, {});
      expect(results[0]?.type).toBe('tool_not_exist');
      const body = (results[0] as ToolNotExist).body();
      expect(body).toMatchObject(unknownDispatch);
      await toolset.close();
    });

    it('routes a custom onResponse ArvoHandlerTool through Toolset', async () => {
      const toolset = new Toolset({ user: userCreateArvoTool });
      await toolset.init();

      const dispatch = {
        id: 'call-1',
        name: 'user>com.user.create',
        args: { name: 'Bob', age: 25 },
      };
      const execResults = await toolset.execute([dispatch]);
      const request = execResults[0] as ArvoHandlerToolResult;

      const response = userCreateEventFactoryV1
        .emits({
          type: 'evt.user.create.success',
          source: 'com.user.create',
          data: { created: true },
        })
        .toJSON();

      const results = await toolset.onExternalResponse(
        dispatch,
        request,
        response as Record<string, unknown>,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as Record<string, unknown>;
      expect(body.processed).toBe(true);
      expect(body.created).toBe(true);
      await toolset.close();
    });

    it('returns error when response has unrecognized event type', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();

      const dispatch = { id: 'call-1', name: 'arvo>com.calculator.add', args: { numbers: [1] } };
      const execResults = await toolset.execute([dispatch]);
      const request = execResults[0] as ArvoHandlerToolResult;

      const validEvent = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: 'com.calculator.add',
          data: { result: 1 },
        })
        .toJSON();
      const badResponse = { ...validEvent, type: 'evt.wrong.type' };

      const results = await toolset.onExternalResponse(
        dispatch,
        request,
        badResponse as Record<string, unknown>,
      );
      expect(results[0]?.type).toBe('error');
      await toolset.close();
    });
  });

  describe('close()', () => {
    it('clears the index so metadata returns empty', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      expect(Object.keys(toolset.metadata()).length).toBeGreaterThan(0);
      await toolset.close();
      expect(toolset.metadata()).toEqual({});
    });

    it('has() returns false for all keys after close', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      await toolset.close();
      expect(toolset.has('arvo>com.calculator.add')).toBe(false);
    });
  });
});
