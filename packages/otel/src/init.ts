import { diag, DiagLogLevel, ProxyTracerProvider, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";

export type TracingHandles = {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

// Bound at module load, before the preload entry patches console.error/warn. A diag
// logger resolving console.* at call time would turn an export failure into a log
// record that fails to export, into another diag error — an unbounded loop.
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const noop = () => {};

let handles: TracingHandles | undefined;

export function initTracing(): TracingHandles {
  if (handles) {
    diag.warn("initTracing() called more than once; reusing the existing SDK");
    return handles;
  }

  const sdk = new NodeSDK();
  sdk.start();

  // After start(): NodeSDK's constructor installs a DiagConsoleLogger whenever
  // OTEL_LOG_LEVEL is set, which would clobber the original-console binding above.
  diag.setLogger(
    { error: originalConsoleError, warn: originalConsoleWarn, info: noop, debug: noop, verbose: noop },
    DiagLogLevel.ERROR
  );

  handles = {
    async forceFlush() {
      const provider = trace.getTracerProvider();
      const delegate = provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider;
      await (delegate as { forceFlush?(): Promise<void> }).forceFlush?.();
    },
    shutdown: () => sdk.shutdown(),
  };
  return handles;
}
