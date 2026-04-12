import http from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IMediaResultData, ToolNotExist } from '../../src';
import { MCPClient, Skill, Toolset } from '../../src';
import { addTool, greetTool } from '../FunctionTool/tools';

const PORT = 47823;
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
  httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

const STDIO_SERVER = path.resolve(__dirname, '../MCPClient/fixtures/stdio-server.cjs');
const SKILLS_DIR = path.resolve(__dirname, '../SkillTool/fixtures/skills');

const makeHttpMcp = () =>
  new MCPClient({ name: 'http', transport: { type: 'http', url: MCP_URL } });
const makeStdioMcp = () =>
  new MCPClient({
    name: 'stdio',
    transport: { type: 'stdio', command: 'node', args: [STDIO_SERVER] },
  });
const makeSkills = () => new Skill({ name: 'skills', directory: SKILLS_DIR });

describe('Toolset (all tool types)', () => {
  describe('metadata()', () => {
    it('indexes all tool types under their compound keys', async () => {
      const toolset = new Toolset({
        fn: addTool,
        httpMcp: makeHttpMcp(),
        skills: makeSkills(),
      });
      await toolset.init();
      const meta = toolset.metadata();

      console.log({ saad: meta });

      // FunctionTool
      expect(meta['fn>add']).toBeDefined();

      // HTTP MCPClient
      expect(meta['httpMcp>echo']).toBeDefined();
      expect(meta['httpMcp>get_image']).toBeDefined();

      // Skill
      expect(meta['skills>greet']).toBeDefined();
      expect(meta['skills>math']).toBeDefined();
      expect(meta['skills>summarise']).toBeDefined();

      await toolset.close();
    });

    it('compound key is used as the name in metadata', async () => {
      const toolset = new Toolset({ fn: addTool, skills: makeSkills() });
      await toolset.init();
      const meta = toolset.metadata();
      expect(meta['fn>add']?.name).toBe('fn>add');
      expect(meta['skills>greet']?.name).toBe('skills>greet');
      await toolset.close();
    });
  });

  describe('execute() — FunctionTool', () => {
    it('routes to add tool', async () => {
      const toolset = new Toolset({ fn: addTool, httpMcp: makeHttpMcp(), skills: makeSkills() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'fn>add', args: { a: 3, b: 7 } }]);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ sum: 10 });
      await toolset.close();
    });

    it('routes to greet tool', async () => {
      const toolset = new Toolset({ fn: greetTool, skills: makeSkills() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'fn>greet', args: { name: 'Bob' } }]);
      expect(results[0]?.type).toBe('json');
      expect(await results[0]?.body()).toEqual({ message: 'Hello, Bob!' });
      await toolset.close();
    });
  });

  describe('execute() — HTTP MCPClient', () => {
    it('routes to echo and returns json', async () => {
      const toolset = new Toolset({ fn: addTool, httpMcp: makeHttpMcp() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'httpMcp>echo', args: { message: 'hi' } },
      ]);
      expect(results[0]?.type).toBe('json');
      await toolset.close();
    });

    it('routes to get_image and returns media', async () => {
      const toolset = new Toolset({ fn: addTool, httpMcp: makeHttpMcp() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'httpMcp>get_image', args: {} }]);
      expect(results[0]?.type).toBe('media');
      expect((await (results[0] as IMediaResultData).metadata()).mediatype).toBe('image');
      await toolset.close();
    });
  });

  describe('execute() — stdio MCPClient', () => {
    it('routes to stdio echo', async () => {
      const toolset = new Toolset({ fn: addTool, stdioMcp: makeStdioMcp() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'stdioMcp>echo', args: { message: 'hello' } },
      ]);
      expect(results[0]?.type).toBe('json');
      await toolset.close();
    });

    it('routes to stdio add', async () => {
      const toolset = new Toolset({ fn: greetTool, stdioMcp: makeStdioMcp() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'stdioMcp>add', args: { a: 5, b: 5 } },
      ]);
      expect(results[0]?.type).toBe('json');
      await toolset.close();
    });
  });

  describe('execute() — Skill', () => {
    it('routes to a flat skill and returns instructions', async () => {
      const toolset = new Toolset({ fn: addTool, skills: makeSkills() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'skills>greet', args: { name: 'Alice' } },
      ]);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as { skill: string; instructions: string };
      expect(body.skill).toBe('greet');
      expect(body.instructions).toBeTruthy();
      await toolset.close();
    });

    it('routes to a deeply nested skill', async () => {
      const toolset = new Toolset({ fn: addTool, skills: makeSkills() });
      await toolset.init();
      const results = await toolset.execute([{ id: '1', name: 'skills>summarise', args: {} }]);
      expect(results[0]?.type).toBe('json');
      await toolset.close();
    });
  });

  describe('execute() — parallel cross-tool dispatch', () => {
    it('dispatches all four tool types in a single call', async () => {
      const toolset = new Toolset({
        fn: addTool,
        httpMcp: makeHttpMcp(),
        stdioMcp: makeStdioMcp(),
        skills: makeSkills(),
      });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'fn>add', args: { a: 1, b: 2 } },
        { id: '2', name: 'httpMcp>echo', args: { message: 'hello' } },
        { id: '3', name: 'stdioMcp>echo', args: { message: 'world' } },
        { id: '4', name: 'skills>greet', args: { name: 'Alice' } },
      ]);
      expect(results).toHaveLength(4);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('json');
      expect(results[2]?.type).toBe('json');
      expect(results[3]?.type).toBe('json');
      await toolset.close();
    });

    it('handles mixed results including media across tool types', async () => {
      const toolset = new Toolset({
        fn: addTool,
        httpMcp: makeHttpMcp(),
        skills: makeSkills(),
      });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'fn>add', args: { a: 5, b: 5 } },
        { id: '2', name: 'httpMcp>get_image', args: {} },
        { id: '3', name: 'skills>math', args: { op: 'add' } },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('media');
      expect(results[2]?.type).toBe('json');
      await toolset.close();
    });

    it('returns tool_not_exist for unknown alongside valid dispatches', async () => {
      const toolset = new Toolset({ fn: addTool, httpMcp: makeHttpMcp(), skills: makeSkills() });
      await toolset.init();
      const results = await toolset.execute([
        { id: '1', name: 'fn>add', args: { a: 1, b: 1 } },
        { id: '2', name: 'nonexistent>tool', args: {} },
        { id: '3', name: 'skills>greet', args: {} },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('tool_not_exist');
      expect((results[1] as ToolNotExist).body()).toMatchObject({ name: 'nonexistent>tool' });
      expect(results[2]?.type).toBe('json');
      await toolset.close();
    });
  });

  describe('close()', () => {
    it('closes all tool types and clears the index', async () => {
      const toolset = new Toolset({
        fn: addTool,
        httpMcp: makeHttpMcp(),
        skills: makeSkills(),
      });
      await toolset.init();
      expect(toolset.metadata()['httpMcp>echo']).toBeDefined();
      expect(toolset.metadata()['skills>greet']).toBeDefined();
      await toolset.close();
      const results = await toolset.execute([{ id: '1', name: 'httpMcp>echo', args: {} }]);
      expect(results[0]?.type).toBe('tool_not_exist');
    });
  });
});
