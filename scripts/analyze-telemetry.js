// Script de análise de telemetria (p95/p99 por minuto)
// Roda com Node.js e usa os dados em memória (exportados do middleware)
function analyzeByMinute(metrics) {
  const byMinute = {};

  metrics.forEach(m => {
    if (!byMinute[m.minute]) {
      byMinute[m.minute] = { requests: [], ips: new Set() };
    }
    const bucket = byMinute[m.minute];
    bucket.requests.push(m.count);
    bucket.ips.add(m.ip);
  });

  return Object.keys(byMinute).map(minute => {
    const data = byMinute[minute];
    const requests = data.requests.sort((a, b) => a - b);
    const total = requests.reduce((sum, r) => sum + r, 0);
    const p95Index = Math.ceil(requests.length * 0.95) - 1;
    const p99Index = Math.ceil(requests.length * 0.99) - 1;

    return {
      minute,
      totalRequests: total,
      p95Requests: requests[p95Index] ?? 0,
      p99Requests: requests[p99Index] ?? 0,
      ips: data.ips.size,
    };
  });
}

function main() {
  // Exemplo: carrega os dados exportados do middleware
  // Em produção, viria de log centralizado (serilog/winston/etc)
  const sampleMetrics = [
    { minute: '2026-09-30T12:00', ip: '10.0.0.1', method: 'GET', path: '/v1/categories', count: 5 },
    { minute: '2026-09-30T12:00', ip: '10.0.0.2', method: 'GET', path: '/v1/albums', count: 3 },
    { minute: '2026-09-30T12:00', ip: '10.0.0.1', method: 'GET', path: '/v1/albums', count: 2 },
    { minute: '2026-09-30T12:01', ip: '10.0.0.3', method: 'POST', path: '/v1/sync', count: 1 },
    { minute: '2026-09-30T12:01', ip: '10.0.0.1', method: 'GET', path: '/v1/categories', count: 7 },
    { minute: '2026-09-30T12:01', ip: '10.0.0.2', method: 'GET', path: '/v1/categories', count: 4 },
  ];

  const stats = analyzeByMinute(sampleMetrics);

  console.log("Relatório de telemetria (p95/p99 por minuto)");
  console.log("=============================================");
  console.log("Minute        | Total Requests | P95 Req/min | P99 Req/min | Unique IPs\n");
  console.log("--------------|----------------|-------------|-------------|-----------");

  stats.forEach(s => {
    console.log(`${s.minute} | ${s.totalRequests.toString().padStart(13)} | ${s.p95Requests.toString().padStart(11)} | ${s.p99Requests.toString().padStart(11)} | ${s.ips}`);
  });

  const totalRequests = stats.reduce((sum, s) => sum + s.totalRequests, 0);
  const avgP95 = stats.reduce((sum, s) => sum + s.p95Requests, 0) / (stats.length || 1);
  const avgP99 = stats.reduce((sum, s) => sum + s.p99Requests, 0) / (stats.length || 1);

  console.log(`\nAggregate:\n- Total requests analyzed: ${totalRequests}\n- Average P95 req/min: ${avgP95.toFixed(1)}\n- Average P99 req/min: ${avgP99.toFixed(1)}`);
}

main();