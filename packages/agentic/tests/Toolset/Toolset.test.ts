import { describe, expect, it } from 'vitest';
import { type ToolNotExist, Toolset } from '../../src/';
import { addTool, failingTool, greetTool, imageTool } from '../FunctionTool/tools';

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
  });
});
