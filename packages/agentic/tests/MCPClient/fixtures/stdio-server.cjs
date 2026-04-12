const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'test-server', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Echoes the message', inputSchema: { message: z.string() } },
  async ({ message }) => ({
    content: [{ type: 'text', text: message }],
  }),
);

server.registerTool(
  'add',
  { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
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

const transport = new StdioServerTransport();
server.connect(transport);
