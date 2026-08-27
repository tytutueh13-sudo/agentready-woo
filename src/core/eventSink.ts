// Observability (section 46). NullEventSink is the default — emitting
// events is opt-in, never required for the guard chain to function.
// MemoryEventSink is what local tests use to assert events actually fired.
import type { EventSink, GuardEvent } from "./types.ts";

export class NullEventSink implements EventSink {
  emit(_event: GuardEvent): void {
    // intentionally does nothing
  }
}

export class MemoryEventSink implements EventSink {
  events: GuardEvent[] = [];

  emit(event: GuardEvent): void {
    this.events.push(event);
  }
}

// Section 47: aggregate query shape a future dashboard GUI can render
// directly. Computed from in-memory events here; a deployed product would
// compute the equivalent from KV/D1 — same shape either way.
export function summarizeEvents(events: GuardEvent[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const event of events) {
    summary[event.type] = (summary[event.type] ?? 0) + 1;
  }
  return summary;
}
