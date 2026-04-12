import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IMediaResultData } from '../../src';
import { MCPClient } from '../../src';

const PORT = 47821;
const URL = `http://localhost:${PORT}/mcp`;

let httpServer: http.Server;

function createMcpServer() {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echoes the message', inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: 'text', text: message }] }),
  );
  server.registerTool(
    'add',
    { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  server.registerTool('get_image', { description: 'Returns a test image' }, async () => ({
    content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
  }));
  server.registerTool('get_audio', { description: 'Returns test audio' }, async () => ({
    content: [{ type: 'audio', data: 'd29ybGQ=', mimeType: 'audio/mpeg' }],
  }));
  server.registerTool('get_mixed', { description: 'Returns text and image' }, async () => ({
    content: [
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ],
  }));
  return server;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });
}

beforeAll(async () => {
  httpServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer();
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('MCPClient (http)', () => {
  describe('init()', () => {
    it('connects and discovers tools', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      expect(client.has('echo')).toBe(true);
      expect(client.has('add')).toBe(true);
      expect(client.has('get_image')).toBe(true);
      expect(client.has('get_audio')).toBe(true);
      await client.close();
    });
  });

  describe('metadata()', () => {
    it('returns tool definitions after init', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const meta = client.metadata();
      expect(meta?.echo).toBeDefined();
      expect(meta?.echo?.description).toBeDefined();
      expect(meta?.add?.inputSchema).toBeDefined();
      await client.close();
    });

    it('returns empty object before init', () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      expect(client.metadata()).toEqual({});
    });
  });

  describe('execute()', () => {
    it('calls echo and returns json result', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const results = await client.execute([{ id: '1', name: 'echo', args: { message: 'hello' } }]);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as { type: string; text: string };
      expect(body.text).toBe('hello');
      await client.close();
    });

    it('calls add and returns correct result', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const results = await client.execute([{ id: '1', name: 'add', args: { a: 3, b: 7 } }]);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as { type: string; text: string };
      expect(body.text).toBe('10');
      await client.close();
    });

    it('returns media result for image tool', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const results = await client.execute([{ id: '1', name: 'get_image', args: {} }]);
      expect(results[0]?.type).toBe('media');
      const media = results[0] as IMediaResultData;
      expect(await media.body()).toBe('aGVsbG8=');
      const meta = await media.metadata();
      expect(meta.mediatype).toBe('image');
      expect(meta.contenttype).toBe('image/png');
      expect(meta.format).toBe('base64');
      await client.close();
    });

    it('returns media result for audio tool', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const results = await client.execute([{ id: '1', name: 'get_audio', args: {} }]);
      expect(results[0]?.type).toBe('media');
      const media = results[0] as IMediaResultData;
      expect(await media.body()).toBe('d29ybGQ=');
      const meta = await media.metadata();
      expect(meta.mediatype).toBe('audio');
      expect(meta.contenttype).toBe('audio/mpeg');
      expect(meta.format).toBe('base64');
      await client.close();
    });

    it('returns multiple results for mixed content tool', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const results = await client.execute([{ id: '1', name: 'get_mixed', args: {} }]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('media');
      await client.close();
    });

    it('returns error for unknown tool name', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const results = await client.execute([{ id: '1', name: 'unknown', args: {} }]);
      expect(results[0]?.type).toBe('error');
      await client.close();
    });

    it('returns error when called before init', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      const results = await client.execute([{ id: '1', name: 'echo', args: { message: 'hi' } }]);
      expect(results[0]?.type).toBe('error');
    });

    it('handles multiple dispatches in parallel', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      const results = await client.execute([
        { id: '1', name: 'add', args: { a: 1, b: 2 } },
        { id: '2', name: 'add', args: { a: 10, b: 20 } },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('json');
      await client.close();
    });
  });

  describe('close()', () => {
    it('clears metadata after close', async () => {
      const client = new MCPClient({ name: 'test', transport: { type: 'http', url: URL } });
      await client.init();
      expect(client.has('echo')).toBe(true);
      await client.close();
      expect(client.has('echo')).toBe(false);
      expect(client.metadata()).toEqual({});
    });
  });
});
