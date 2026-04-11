import { z } from 'zod';
import { FunctionTool, JsonResultData, MediaResultData } from '../../src/';

export const addTool = new FunctionTool({
  name: 'add',
  description: 'Adds two numbers and returns the sum',
  input: z.object({ a: z.number(), b: z.number() }),
  fn: ({ data }) => {
    const { a, b } = data as { a: number; b: number };
    return [new JsonResultData('result', { sum: a + b })];
  },
});

export const greetTool = new FunctionTool({
  name: 'greet',
  description: 'Returns a greeting for the given name',
  input: z.object({ name: z.string() }),
  fn: ({ id, data }) => {
    const { name } = data as { name: string };
    return [new JsonResultData(id, { message: `Hello, ${name}!` })];
  },
});

export const failingTool = new FunctionTool({
  name: 'failing',
  description: 'Always throws an error',
  input: z.object({}),
  fn: () => {
    throw new Error('intentional failure');
  },
});

export const imageTool = new FunctionTool({
  name: 'image',
  description: 'Returns a placeholder image',
  input: z.object({ label: z.string() }),
  fn: ({ id }) => [
    new MediaResultData(id, {
      name: 'placeholder.png',
      mediatype: 'image',
      contenttype: 'image/png',
      data: 'aGVsbG8=',
    }),
  ],
});
