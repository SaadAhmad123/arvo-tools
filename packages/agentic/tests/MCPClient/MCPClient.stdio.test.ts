import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IMediaResultData } from '../../src';
import { MCPClient } from '../../src';

const SERVER_PATH = path.resolve(__dirname, 'fixtures/stdio-server.cjs');

describe('MCPClient (stdio)', () => {
  let client: MCPClient;

  beforeEach(() => {
    client = new MCPClient({
      name: 'test',
      transport: { type: 'stdio', command: 'node', args: [SERVER_PATH] },
    });
  });

  afterEach(async () => {
    await client.close();
  });

  describe('init()', () => {
    it('connects and discovers tools', async () => {
      await client.init();
      expect(client.has('echo')).toBe(true);
      expect(client.has('add')).toBe(true);
      expect(client.has('get_image')).toBe(true);
      expect(client.has('get_audio')).toBe(true);
    });
  });

  describe('metadata()', () => {
    it('returns tool definitions after init', async () => {
      await client.init();
      const meta = client.metadata();
      expect(meta?.echo).toBeDefined();
      expect(meta?.add).toBeDefined();
      expect(meta?.add?.inputSchema).toBeDefined();
    });

    it('returns empty object before init', () => {
      expect(client.metadata()).toEqual({});
    });
  });

  describe('execute()', () => {
    it('calls echo and returns json result', async () => {
      await client.init();
      const results = await client.execute([{ id: '1', name: 'echo', args: { message: 'hello' } }]);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as { type: string; text: string };
      expect(body.text).toBe('hello');
    });

    it('calls add and returns correct result', async () => {
      await client.init();
      const results = await client.execute([{ id: '1', name: 'add', args: { a: 4, b: 6 } }]);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as { type: string; text: string };
      expect(body.text).toBe('10');
    });

    it('returns media result for image tool', async () => {
      await client.init();
      const results = await client.execute([{ id: '1', name: 'get_image', args: {} }]);
      expect(results[0]?.type).toBe('media');
      const media = results[0] as IMediaResultData;
      expect(await media.body()).toBe('aGVsbG8=');
      const meta = await media.metadata();
      expect(meta.mediatype).toBe('image');
      expect(meta.contenttype).toBe('image/png');
      expect(meta.format).toBe('base64');
    });

    it('returns media result for audio tool', async () => {
      await client.init();
      const results = await client.execute([{ id: '1', name: 'get_audio', args: {} }]);
      expect(results[0]?.type).toBe('media');
      const media = results[0] as IMediaResultData;
      expect(await media.body()).toBe('d29ybGQ=');
      const meta = await media.metadata();
      expect(meta.mediatype).toBe('audio');
      expect(meta.contenttype).toBe('audio/mpeg');
      expect(meta.format).toBe('base64');
    });

    it('returns multiple results for mixed content tool', async () => {
      await client.init();
      const results = await client.execute([{ id: '1', name: 'get_mixed', args: {} }]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('media');
    });

    it('returns error for unknown tool name', async () => {
      await client.init();
      const results = await client.execute([{ id: '1', name: 'unknown', args: {} }]);
      expect(results[0]?.type).toBe('error');
    });

    it('returns error when called before init', async () => {
      const results = await client.execute([{ id: '1', name: 'echo', args: { message: 'hi' } }]);
      expect(results[0]?.type).toBe('error');
    });

    it('handles multiple dispatches in parallel', async () => {
      await client.init();
      const results = await client.execute([
        { id: '1', name: 'add', args: { a: 1, b: 2 } },
        { id: '2', name: 'add', args: { a: 10, b: 20 } },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('json');
    });
  });

  describe('close()', () => {
    it('clears metadata after close', async () => {
      await client.init();
      expect(client.has('echo')).toBe(true);
      await client.close();
      expect(client.has('echo')).toBe(false);
      expect(client.metadata()).toEqual({});
    });
  });
});
