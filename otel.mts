import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import { OTLPTraceExporter as HTTPExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as ProtoBufExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const serviceName = 'agent-tools-monorepo-tests';

const jaegerExporter = new HTTPExporter({
  url: 'http://localhost:6001/jaeger/v1/traces',
});

const arizePhoenixExporter = new ProtoBufExporter({
  url: 'http://localhost:6001/arize/v1/traces',
});

export const telemetrySdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_PROJECT_NAME]: serviceName,
  }),
  spanProcessors: [
    new SimpleSpanProcessor(jaegerExporter),
    new SimpleSpanProcessor(arizePhoenixExporter),
  ],
});

// Call this function in your application 'index.ts'
export const telemetrySdkStart = () => {
  telemetrySdk.start();
};

export const telemetrySdkStop = async () => {
  await telemetrySdk.shutdown();
};
