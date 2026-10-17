import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Thin wrapper over prom-client with a private registry (no global state, test friendly). */
export class Metrics {
  readonly registry = new Registry();
  private readonly requests: Counter<'method' | 'route' | 'status'>;
  private readonly duration: Histogram<'method' | 'route' | 'status'>;
  readonly socketConnections: Gauge;
  readonly matchQueueSize: Gauge;

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry, prefix: 'vibematch_' });
    this.requests = new Counter({
      name: 'vibematch_http_requests_total',
      help: 'HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: 'vibematch_http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.socketConnections = new Gauge({ name: 'vibematch_socket_connections', help: 'Open sockets', registers: [this.registry] });
    this.matchQueueSize = new Gauge({ name: 'vibematch_match_queue_size', help: 'Users waiting for a match', registers: [this.registry] });
  }

  observe(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    this.requests.inc(labels);
    this.duration.observe(labels, seconds);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
