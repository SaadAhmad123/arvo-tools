import * as dotenv from 'dotenv';
import { afterAll, beforeAll } from 'vitest';
import { telemetrySdkStart, telemetrySdkStop } from './otel';

dotenv.config({ path: '../../.env' });

beforeAll(() => {
  telemetrySdkStart();
});

afterAll(async () => {
  await telemetrySdkStop();
});
