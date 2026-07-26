import { format } from "node:util";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { initTracing } from "./init";

initTracing();

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => (req.url ?? "").split("?")[0] === "/api/health",
    }),
    new ExpressInstrumentation(),
  ],
});

const logger = logs.getLogger("console-capture");

let capturing = false;

function captureConsole(
  original: (...args: unknown[]) => void,
  severityNumber: SeverityNumber,
  severityText: string
) {
  return (...args: unknown[]) => {
    original(...args);
    // An export failure surfaces as a console write from inside the exporter; without
    // this guard that write emits another log record, which fails to export, forever.
    if (capturing) return;
    capturing = true;
    try {
      logger.emit({ severityNumber, severityText, body: format(...args) });
    } finally {
      capturing = false;
    }
  };
}

console.error = captureConsole(console.error.bind(console), SeverityNumber.ERROR, "ERROR");
console.warn = captureConsole(console.warn.bind(console), SeverityNumber.WARN, "WARN");
