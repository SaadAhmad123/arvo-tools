import { describe, expect, it } from 'vitest';
import { FunctionTool, type MediaResultData } from '../../src';
import { addTool, failingTool, greetTool, imageTool } from './tools';

describe('FunctionTool', () => {
  describe('metadata()', () => {
    it('returns the tool name and description', async () => {
      const meta = await addTool.metadata();
      expect(meta?.add?.name).toBe('add');
      expect(meta?.add?.description).toBe('Adds two numbers and returns the sum');
    });

    it('includes an input schema', async () => {
      const meta = await addTool.metadata();
      expect(meta?.add?.inputSchema).toBeDefined();
    });
  });

  describe('execute()', () => {
    it('returns a json result for a valid dispatch', async () => {
      const results = await addTool.execute([{ id: '1', name: 'add', args: { a: 2, b: 3 } }]);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ sum: 5 });
    });

    it('passes the dispatch id and name to fn', async () => {
      const results = await greetTool.execute([
        { id: 'req-1', name: 'greet', args: { name: 'Alice' } },
      ]);
      expect(results[0]?.id).toBe('req-1');
      expect(await results[0]?.body()).toEqual({ message: 'Hello, Alice!' });
    });

    it('returns void result as empty array', async () => {
      const { z } = await import('zod');
      const voidTool = new FunctionTool({
        name: 'noop',
        description: 'Does nothing',
        input: z.object({}),
        fn: () => {},
      });
      const results = await voidTool.execute([{ id: '1', name: 'noop', args: {} }]);
      expect(results).toHaveLength(0);
    });

    it('returns an error result when the dispatch name does not match', async () => {
      const results = await addTool.execute([{ id: '1', name: 'wrong', args: {} }]);
      expect(results[0]?.type).toBe('error');
    });

    it('returns an error result when args fail schema validation', async () => {
      const results = await addTool.execute([
        { id: '1', name: 'add', args: { a: 'not-a-number', b: 3 } },
      ]);
      expect(results[0]?.type).toBe('error');
    });

    it('returns an error result when fn throws', async () => {
      const results = await failingTool.execute([{ id: '1', name: 'failing', args: {} }]);
      expect(results[0]?.type).toBe('error');
      expect(await results[0]?.body()).toContain('intentional failure');
    });

    it('handles multiple dispatches and flattens results', async () => {
      const results = await addTool.execute([
        { id: '1', name: 'add', args: { a: 1, b: 2 } },
        { id: '2', name: 'add', args: { a: 10, b: 20 } },
      ]);
      expect(results).toHaveLength(2);
      expect(await results[0]?.body()).toEqual({ sum: 3 });
      expect(await results[1]?.body()).toEqual({ sum: 30 });
    });

    it('handles mixed success and error dispatches', async () => {
      const results = await addTool.execute([
        { id: '1', name: 'add', args: { a: 1, b: 2 } },
        { id: '2', name: 'add', args: { a: 'bad', b: 2 } },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('error');
    });

    it('returns a media result for a tool that returns MediaResultData', async () => {
      const results = await imageTool.execute([
        { id: '1', name: 'image', args: { label: 'test' } },
      ]);
      expect(results[0]?.type).toBe('media');
      const media = results[0] as MediaResultData;
      expect(await media.body()).toBe('aGVsbG8=');
      expect((await media.metadata()).mediatype).toBe('image');
      expect((await media.metadata()).contenttype).toBe('image/png');
    });
  });
});
