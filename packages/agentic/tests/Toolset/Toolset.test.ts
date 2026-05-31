import { describe, expect, it } from 'vitest';
import {
  type IExternalToolResult,
  type ITool,
  MediaResultData,
  type ToolNotExist,
  Toolset,
} from '../../src/';
import { addTool, failingTool, greetTool, imageTool } from '../FunctionTool/tools';

// ── Error-path mock tools ──────────────────────────────────────────────────

const initThrowingTool: ITool = {
  name: 'init-thrower',
  init: () => {
    throw new Error('init failed');
  },
  close: () => {},
  has: (name) => name === 'init-thrower',
  metadata: () => ({
    'init-thrower': { name: 'init-thrower', description: 'throws on init', inputSchema: {} },
  }),
  execute: async () => [],
  onExternalResponse: async () => [],
};

const closeThrowingTool: ITool = {
  name: 'close-thrower',
  init: () => {},
  close: () => {
    throw new Error('close failed');
  },
  has: (name) => name === 'close-thrower',
  metadata: () => ({
    'close-thrower': { name: 'close-thrower', description: 'throws on close', inputSchema: {} },
  }),
  execute: async () => [],
  onExternalResponse: async () => [],
};

// execute() itself throws — distinct from a tool that returns ErrorResultData
const executeThrowingTool: ITool = {
  name: 'execute-thrower',
  init: () => {},
  close: () => {},
  has: (name) => name === 'execute-thrower',
  metadata: () => ({
    'execute-thrower': {
      name: 'execute-thrower',
      description: 'throws on execute',
      inputSchema: {},
    },
  }),
  execute: async () => {
    throw new Error('execute failed');
  },
  onExternalResponse: async () => [],
};

// onExternalResponse() returns a media result — exercises the media logging branch
const mediaResponseTool: ITool = {
  name: 'media-responder',
  init: () => {},
  close: () => {},
  has: (name) => name === 'media-responder',
  metadata: () => ({
    'media-responder': {
      name: 'media-responder',
      description: 'returns media on response',
      inputSchema: {},
    },
  }),
  execute: async (dispatches) =>
    dispatches.map((d) => ({ id: d.id, type: 'external_call' as const, body: () => ({}) })),
  onExternalResponse: async (request) => [
    new MediaResultData(request.id, {
      name: 'output.png',
      mediatype: 'image',
      contenttype: 'image/png',
      data: 'aGVsbG8=',
    }),
  ],
};

// onExternalResponse() itself throws — exercises the catch block
const responseThrowingTool: ITool = {
  name: 'response-thrower',
  init: () => {},
  close: () => {},
  has: (name) => name === 'response-thrower',
  metadata: () => ({
    'response-thrower': {
      name: 'response-thrower',
      description: 'throws on response',
      inputSchema: {},
    },
  }),
  execute: async (dispatches) =>
    dispatches.map((d) => ({ id: d.id, type: 'external_call' as const, body: () => ({}) })),
  onExternalResponse: async () => {
    throw new Error('response failed');
  },
};

describe('Toolset', () => {
  describe('metadata()', () => {
    it('returns an empty object before init', async () => {
      const toolset = new Toolset({ add: addTool });
      expect(toolset.metadata()).toEqual({});
    });

    it('returns indexed metadata after init', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const meta = toolset.metadata();
      expect(meta['add>add']).toBeDefined();
      expect(meta['add>add']?.name).toBe('add>add');
      expect(meta['add>add']?.description).toBe('Adds two numbers and returns the sum');
      await toolset.close();
    });

    it('indexes multiple tools with their compound keys', async () => {
      const toolset = new Toolset({ add: addTool, greet: greetTool });
      await toolset.init();
      const meta = toolset.metadata();
      expect(meta['add>add']).toBeDefined();
      expect(meta['greet>greet']).toBeDefined();
      await toolset.close();
    });

    it('includes inputSchema in metadata', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const meta = toolset.metadata();
      expect(meta['add>add']?.inputSchema).toBeDefined();
      await toolset.close();
    });
  });

  describe('execute()', () => {
    it('routes a dispatch to the correct tool and returns its result', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'add>add', args: { a: 2, b: 3 } }]);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ sum: 5 });
      await toolset.close();
    });

    it('returns tool_not_exist for an unknown tool name', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'unknown>tool', args: {} }]);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('tool_not_exist');
      await toolset.close();
    });

    it('tool_not_exist result body contains the original dispatch', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const dispatch = { id: '1', name: 'unknown>tool', args: { foo: 'bar' } };
      const results = await toolset.execute([dispatch]);
      const result = results[0] as ToolNotExist;
      expect(result.body()).toMatchObject(dispatch);
      await toolset.close();
    });

    it('returns an error result when the underlying tool throws', async () => {
      const toolset = new Toolset({ failing: failingTool });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'failing>failing', args: {} }]);
      expect(results[0]?.type).toBe('error');
      await toolset.close();
    });

    it('handles multiple dispatches in parallel', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'add>add', args: { a: 1, b: 2 } },
        { id: '2', name: 'add>add', args: { a: 10, b: 20 } },
      ]);
      expect(results).toHaveLength(2);
      expect(await results[0]?.body()).toEqual({ sum: 3 });
      expect(await results[1]?.body()).toEqual({ sum: 30 });
      await toolset.close();
    });

    it('handles mixed found and not-found dispatches', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'add>add', args: { a: 1, b: 2 } },
        { id: '2', name: 'unknown>tool', args: {} },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('tool_not_exist');
      await toolset.close();
    });

    it('handles mixed success and error dispatches', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'add>add', args: { a: 1, b: 2 } },
        { id: '2', name: 'add>add', args: { a: 'bad', b: 2 } },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('error');
      await toolset.close();
    });

    it('routes to the correct tool in a multi-tool toolset', async () => {
      const toolset = new Toolset({ add: addTool, greet: greetTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'greet>greet', args: { name: 'Alice' } },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ message: 'Hello, Alice!' });
      await toolset.close();
    });

    it('returns a media result for a tool that returns MediaResultData', async () => {
      const toolset = new Toolset({ image: imageTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'image>image', args: { label: 'test' } },
      ]);
      expect(results[0]?.type).toBe('media');
      await toolset.close();
    });

    it('dispatches multiple different tools in a single execute call', async () => {
      const toolset = new Toolset({ add: addTool, greet: greetTool, image: imageTool });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'add>add', args: { a: 4, b: 6 } },
        { id: '2', name: 'greet>greet', args: { name: 'Bob' } },
        { id: '3', name: 'image>image', args: { label: 'banner' } },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ sum: 10 });
      expect(results[1]?.type).toBe('json');
      expect(await results[1]?.body()).toEqual({ message: 'Hello, Bob!' });
      expect(results[2]?.type).toBe('media');
      await toolset.close();
    });

    it('returns empty array for empty dispatches', async () => {
      const toolset = new Toolset({ add: addTool });
      await toolset.init();
      const results = await toolset.execute([]);
      expect(results).toHaveLength(0);
      await toolset.close();
    });

    it('returns error when the underlying tool execute() itself throws', async () => {
      const toolset = new Toolset({ et: executeThrowingTool });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'et>execute-thrower', args: {} }]);
      expect(results[0]?.type).toBe('error');
      await toolset.close();
    });
  });

  describe('init()', () => {
    it('rethrows when a registered tool init() throws', async () => {
      const toolset = new Toolset({ it: initThrowingTool });
      await expect(toolset.init()).rejects.toThrow('init failed');
    });
  });

  describe('close()', () => {
    it('does not rethrow when a registered tool close() throws', async () => {
      const toolset = new Toolset({ ct: closeThrowingTool });
      await toolset.init();
      await toolset.close(); // must not throw
    });
  });

  describe('onExternalResponse()', () => {
    it('returns media result when the underlying tool returns media', async () => {
      const toolset = new Toolset({ mr: mediaResponseTool });
      await toolset.init();

      const dispatch = { id: 'req-1', name: 'mr>media-responder', args: {} };
      const execResults = await toolset.execute([dispatch]);
      expect(execResults[0]?.type).toBe('external_call');

      const results = await toolset.onExternalResponse(
        dispatch,
        execResults[0] as IExternalToolResult,
        {},
      );
      expect(results[0]?.type).toBe('media');
      await toolset.close();
    });

    it('returns error when the underlying tool onExternalResponse() throws', async () => {
      const toolset = new Toolset({ rt: responseThrowingTool });
      await toolset.init();

      const dispatch = { id: 'req-1', name: 'rt>response-thrower', args: {} };
      const execResults = await toolset.execute([dispatch]);

      const results = await toolset.onExternalResponse(
        dispatch,
        execResults[0] as IExternalToolResult,
        {},
      );
      expect(results[0]?.type).toBe('error');
      await toolset.close();
    });

    it('returns tool_not_exist for an unknown compound key', async () => {
      const toolset = new Toolset({ mr: mediaResponseTool });
      await toolset.init();

      const dispatch = { id: 'req-1', name: 'mr>media-responder', args: {} };
      const execResults = await toolset.execute([dispatch]);

      const unknownDispatch = { ...dispatch, name: 'mr>unknown' };
      const results = await toolset.onExternalResponse(
        unknownDispatch,
        execResults[0] as IExternalToolResult,
        {},
      );
      expect(results[0]?.type).toBe('tool_not_exist');
      await toolset.close();
    });
  });
});
