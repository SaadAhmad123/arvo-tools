import http from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IMediaResultData } from '../../src';
import { MCPClient, Toolset } from '../../src';
import { addTool, greetTool } from '../FunctionTool/tools';

const PORT = 47822;
const MCP_URL = `http://localhost:${PORT}/mcp`;

let httpServer: http.Server;

function createMcpServer() {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echoes the message', inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: 'text', text: message }] }),
  );
  server.registerTool('get_image', { description: 'Returns a test image' }, async () => ({
    content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
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

const STDIO_SERVER_PATH = path.resolve(__dirname, '../MCPClient/fixtures/stdio-server.cjs');

function makeStdioClient() {
  return new MCPClient({
    name: 'stdio',
    transport: { type: 'stdio', command: 'node', args: [STDIO_SERVER_PATH] },
  });
}

function makeHttpClient() {
  return new MCPClient({ name: 'http', transport: { type: 'http', url: MCP_URL } });
}

describe('Toolset (mixed: FunctionTool + MCPClient)', () => {
  describe('metadata()', () => {
    it('indexes keys from all tool types after init', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const meta = toolset.metadata();
      expect(meta['fn>add']).toBeDefined();
      expect(meta['mcp>echo']).toBeDefined();
      expect(meta['mcp>get_image']).toBeDefined();
      await toolset.close();
    });

    it('compound key name matches the index key', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const meta = toolset.metadata();
      expect(meta['fn>add']?.name).toBe('fn>add');
      expect(meta['mcp>echo']?.name).toBe('mcp>echo');
      await toolset.close();
    });
  });

  describe('execute() — FunctionTool routing', () => {
    it('routes to FunctionTool and returns json', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'fn>add', args: { a: 4, b: 6 } }]);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ sum: 10 });
      await toolset.close();
    });

    it('routes to greetTool correctly', async () => {
      const toolset = new Toolset({ fn: greetTool, mcp: makeHttpClient() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'fn>greet', args: { name: 'Alice' } },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ message: 'Hello, Alice!' });
      await toolset.close();
    });
  });

  describe('execute() — HTTP MCPClient routing', () => {
    it('routes to MCP echo tool and returns json', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'mcp>echo', args: { message: 'hi' } },
      ]);
      expect(results[0]?.type).toBe('json');
      await toolset.close();
    });

    it('routes to MCP image tool and returns media', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'mcp>get_image', args: {} }]);
      expect(results[0]?.type).toBe('media');
      const meta = await (results[0] as IMediaResultData).metadata();
      expect(meta.mediatype).toBe('image');
      await toolset.close();
    });

    it('routes to MCP mixed tool and returns multiple results', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'mcp>get_mixed', args: {} }]);
      expect(results).toHaveLength(2);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('media');
      await toolset.close();
    });
  });

  describe('execute() — stdio MCPClient routing', () => {
    it('routes to stdio MCP echo tool and returns json', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeStdioClient() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'mcp>echo', args: { message: 'hello' } },
      ]);
      expect(results[0]?.type).toBe('json');
      await toolset.close();
    });

    it('routes to stdio MCP image tool and returns media', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeStdioClient() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'mcp>get_image', args: {} }]);
      expect(results[0]?.type).toBe('media');
      await toolset.close();
    });
  });

  describe('execute() — parallel cross-tool dispatch', () => {
    it('dispatches to FunctionTool and HTTP MCP in the same call', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'fn>add', args: { a: 1, b: 2 } },
        { id: '2', name: 'mcp>echo', args: { message: 'hello' } },
        { id: '3', name: 'mcp>get_image', args: {} },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('json');
      expect(results[2]?.type).toBe('media');
      await toolset.close();
    });

    it('handles unknown tool alongside valid ones', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'fn>add', args: { a: 5, b: 5 } },
        { id: '2', name: 'unknown>tool', args: {} },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('tool_not_exist');
      await toolset.close();
    });
  });

  describe('close()', () => {
    it('closes all tools including MCPClient', async () => {
      const toolset = new Toolset({ fn: addTool, mcp: makeHttpClient() });
      await toolset.init();
      expect(toolset.metadata()['mcp>echo']).toBeDefined();
      await toolset.close();
      // After close, Toolset metadata is still accessible (it's the MCPClient that clears its own cache)
      // Re-executing should error since MCP is disconnected
      const results = await toolset.execute([
        { id: '1', name: 'mcp>echo', args: { message: 'x' } },
      ]);
      expect(results[0]?.type).toBe('tool_not_exist');
    });
  });
});
