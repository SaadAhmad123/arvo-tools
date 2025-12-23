import { afterAll, beforeAll } from 'vitest';
import { telemetrySdkStart, telemetrySdkStop } from './otel';

beforeAll(() => {
  telemetrySdkStart();
});

afterAll(async () => {
  await telemetrySdkStop();
});
