import { cleanString, createArvoContract } from 'arvo-core';
import { createArvoEventHandler, type EventHandlerFactory } from 'arvo-event-handler';
import { z } from 'zod';

/**
 * Calculator event handler for mathematical operations that are
 * computationally intensive or difficult for agents to execute directly.
 *
 * This handler accepts JavaScript mathematical expressions and evaluates
 * them within a strictly sandboxed environment. Within the Arvo event-driven
 * architecture, this handler can be invoked by users, ArvoOrchestrators,
 * ArvoResumables, and Agentic ArvoResumables through the event broker.
 *
 * The toolUseId$$ passthrough field enables participation in agentic workflows
 * by providing the correlation identifier required by LLMs to track tool call
 * execution across the request-response cycle.
 */
export const calculatorContract = createArvoContract({
  uri: '#/amas/calculator/execute',
  type: 'com.calculator.execute',
  description: cleanString(`
    Evaluates mathematical expressions in a secure sandboxed environment. 
    Supports arithmetic operations, common mathematical functions (trigonometric, logarithmic, 
    exponential, rounding), and constants (PI, E). Does not support: symbolic algebra, equation 
    solving, calculus operations, matrix operations, statistical analysis, or custom function definitions.  

    # Critical Tool Limitation

    Your calculator tool evaluates ONLY numeric expressions - it cannot solve equations or work with variables.

    **Valid inputs:** "2 + 2", "sqrt(16) * 5", "(3 * 10) / 2", "45 * 8 + 62 * 3"
    **Invalid inputs:** "3 * w = 30", "solve 2x + 4 = 6", "x = sqrt(1500)"

    When solving problems with variables:
    - Solve for the variable value algebraically in your reasoning
    - Once you know the numeric value, use the calculator with pure numbers
    - Example: To solve "3w = 30", determine w = 10 mentally, then calculate with "10" not "w" but rather "30/3"
  `),
  versions: {
    '1.0.0': {
      accepts: z.object({
        expression: z
          .string()
          .describe(
            'Mathematical expression to evaluate. Supports arithmetic operators (+, -, *, /, %, **), ' +
              'Math functions (sqrt, pow, sin, cos, tan, asin, acos, atan, log, exp, abs, round, min, max, floor, ceil), ' +
              'and constants (PI, E). Examples: "2 + 2", "sqrt(16) * 5", "PI * pow(2, 3)", "sin(PI/2)", "(45 * 8) + (62 * 3)"',
          ),
      }),
      emits: {
        'evt.calculator.execute.success': z.object({
          result: z.number().describe('Numeric result of the evaluated expression'),
          expression: z.string().describe('Original expression that was evaluated'),
        }),
      },
    },
  },
});

export const calculatorHandler: EventHandlerFactory = () =>
  createArvoEventHandler({
    contract: calculatorContract,
    handler: {
      '1.0.0': async ({ event }) => {
        const { expression } = event.data;

        if (!expression || expression.trim().length === 0) {
          throw new Error('Expression cannot be empty');
        }

        try {
          const result = evaluateMathExpression(expression);

          if (typeof result !== 'number' || !Number.isFinite(result)) {
            throw new Error('Expression must evaluate to a finite number');
          }

          return {
            type: 'evt.calculator.execute.success',
            data: {
              result,
              expression,
            },
            executionunits: expression.length * 1e-6,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          throw new Error(`Failed to evaluate expression: ${message}`);
        }
      },
    },
  });

function evaluateMathExpression(expr: string): number {
  const whitelist = /^[0-9+\-*/().%\s,]+$/;

  const safeExpr = expr
    .replace(/\bPI\b/g, 'PI')
    .replace(/\bE\b/g, 'E')
    .replace(/\bsqrt\b/g, 'sqrt')
    .replace(/\bpow\b/g, 'pow')
    .replace(/\babs\b/g, 'abs')
    .replace(/\bsin\b/g, 'sin')
    .replace(/\bcos\b/g, 'cos')
    .replace(/\btan\b/g, 'tan')
    .replace(/\basin\b/g, 'asin')
    .replace(/\bacos\b/g, 'acos')
    .replace(/\batan\b/g, 'atan')
    .replace(/\blog\b/g, 'log')
    .replace(/\bexp\b/g, 'exp')
    .replace(/\bfloor\b/g, 'floor')
    .replace(/\bceil\b/g, 'ceil')
    .replace(/\bround\b/g, 'round')
    .replace(/\bmin\b/g, 'min')
    .replace(/\bmax\b/g, 'max');

  const testExpr = safeExpr.replace(
    /\b(sqrt|pow|abs|sin|cos|tan|asin|acos|atan|log|exp|floor|ceil|round|min|max|PI|E)\b/g,
    '',
  );

  if (!whitelist.test(testExpr)) {
    throw new Error('Expression contains invalid characters or functions');
  }

  const evalFunc = new Function(
    'sqrt',
    'pow',
    'abs',
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'log',
    'exp',
    'floor',
    'ceil',
    'round',
    'min',
    'max',
    'PI',
    'E',
    `"use strict"; return (${safeExpr});`,
  );

  return evalFunc(
    Math.sqrt,
    Math.pow,
    Math.abs,
    Math.sin,
    Math.cos,
    Math.tan,
    Math.asin,
    Math.acos,
    Math.atan,
    Math.log,
    Math.exp,
    Math.floor,
    Math.ceil,
    Math.round,
    Math.min,
    Math.max,
    Math.PI,
    Math.E,
  );
}
