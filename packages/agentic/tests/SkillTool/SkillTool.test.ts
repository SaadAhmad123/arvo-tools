import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Skill } from '../../src';

const SKILLS_DIR = path.resolve(__dirname, 'fixtures/skills');

describe('Skill', () => {
  let tool: Skill;

  beforeEach(() => {
    tool = new Skill({ name: 'test', directory: SKILLS_DIR });
  });

  afterEach(async () => {
    await tool.close();
  });

  describe('init()', () => {
    it('discovers flat skills', async () => {
      await tool.init();
      expect(tool.has('greet')).toBe(true);
      expect(tool.has('math')).toBe(true);
    });

    it('discovers skills in nested directories', async () => {
      await tool.init();
      expect(tool.has('summarise')).toBe(true);
    });

    it('skips SKILL.md files missing name or description', async () => {
      await tool.init();
      const meta = tool.metadata();
      // 'invalid' skill has no name/description — should not appear
      const names = Object.keys(meta);
      expect(names).not.toContain('invalid');
      expect(names).toHaveLength(3); // greet, math, summarise
    });

    it('returns empty metadata before init', () => {
      expect(tool.metadata()).toEqual({});
    });
  });

  describe('metadata()', () => {
    it('returns name and description for each skill', async () => {
      await tool.init();
      const meta = tool.metadata();
      expect(meta?.greet?.name).toBe('greet');
      expect(meta?.greet?.description).toBe('Greets a person by name with a friendly message.');
      expect(meta?.math?.name).toBe('math');
      expect(meta?.summarise?.name).toBe('summarise');
    });

    it('includes an inputSchema for each skill', async () => {
      await tool.init();
      const meta = tool.metadata();
      expect(meta?.greet?.inputSchema).toBeDefined();
      expect(meta?.math?.inputSchema).toBeDefined();
    });
  });

  describe('execute()', () => {
    it('returns json result with skill name, instructions and args', async () => {
      await tool.init();
      const results = await tool.execute([{ id: '1', name: 'greet', args: { name: 'Alice' } }]);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as {
        skill: string;
        instructions: string;
        args: Record<string, unknown>;
      };
      expect(body.skill).toBe('greet');
      expect(body.instructions).toContain('greeting');
      expect(body.args).toEqual({ name: 'Alice' });
    });

    it('returns the markdown body without frontmatter', async () => {
      await tool.init();
      const results = await tool.execute([{ id: '1', name: 'math', args: {} }]);
      const body = (await results[0]?.body()) as { instructions: string };
      expect(body.instructions).not.toContain('---');
      expect(body.instructions).not.toContain('name: math');
      expect(body.instructions).toContain('arithmetic');
    });

    it('works for a deeply nested skill', async () => {
      await tool.init();
      const results = await tool.execute([{ id: '1', name: 'summarise', args: { text: 'hello' } }]);
      expect(results[0]?.type).toBe('json');
      const body = (await results[0]?.body()) as { instructions: string };
      expect(body.instructions).toContain('summary');
    });

    it('returns error for unknown skill name', async () => {
      await tool.init();
      const results = await tool.execute([{ id: '1', name: 'unknown', args: {} }]);
      expect(results[0]?.type).toBe('error');
    });

    it('returns error when called before init', async () => {
      const results = await tool.execute([{ id: '1', name: 'greet', args: {} }]);
      expect(results[0]?.type).toBe('error');
    });

    it('handles multiple dispatches in parallel', async () => {
      await tool.init();
      const results = await tool.execute([
        { id: '1', name: 'greet', args: { name: 'Alice' } },
        { id: '2', name: 'math', args: { op: 'add' } },
        { id: '3', name: 'summarise', args: { text: 'test' } },
      ]);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.type === 'json')).toBe(true);
    });

    it('handles mixed valid and unknown skills in one call', async () => {
      await tool.init();
      const results = await tool.execute([
        { id: '1', name: 'greet', args: {} },
        { id: '2', name: 'nonexistent', args: {} },
      ]);
      expect(results[0]?.type).toBe('json');
      expect(results[1]?.type).toBe('error');
    });
  });

  describe('close()', () => {
    it('clears the skill index', async () => {
      await tool.init();
      expect(tool.has('greet')).toBe(true);
      await tool.close();
      expect(tool.has('greet')).toBe(false);
      expect(tool.metadata()).toEqual({});
    });
  });
});
