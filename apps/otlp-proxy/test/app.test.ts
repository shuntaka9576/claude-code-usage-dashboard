import { createApp } from '../src/app.js';

const makeApp = (upstream: { status: number; body: string }) => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const emitted: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: String(init?.body),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const app = createApp({
    region: 'ap-northeast-1',
    eventsLogGroup: '/claude-code/events',
    eventsLogStream: 'default',
    metricsNamespace: 'claude-code',
    credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
    fetchImpl,
    emit: (line) => emitted.push(line),
    now: () => 1700000000000,
  });
  return { app, calls, emitted };
};

describe('otlp-proxy app', () => {
  it('/v1/metrics を monitoring エンドポイントへ SigV4 付きで転送し EMF を出力する', async () => {
    const { app, calls, emitted } = makeApp({ status: 200, body: '{}' });
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 1 }] } }],
            },
          ],
        },
      ],
    };

    const res = await app.request('/v1/metrics', { method: 'POST', body: JSON.stringify(payload) });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://monitoring.ap-northeast-1.amazonaws.com/v1/metrics');
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(calls[0].body).toBe(JSON.stringify(payload));
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0])).toMatchObject({ Cost: 1 });
  });

  it('/v1/logs は x-aws-log-group/stream を付与して logs エンドポイントへ転送する', async () => {
    const { app, calls } = makeApp({ status: 200, body: '{}' });

    const res = await app.request('/v1/logs', { method: 'POST', body: '{"resourceLogs":[]}' });

    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://logs.ap-northeast-1.amazonaws.com/v1/logs');
    expect(calls[0].headers['x-aws-log-group']).toBe('/claude-code/events');
    expect(calls[0].headers['x-aws-log-stream']).toBe('default');
  });

  it('上流のエラーステータスを素通しする', async () => {
    const { app } = makeApp({ status: 429, body: '{"message":"throttled"}' });
    const res = await app.request('/v1/metrics', { method: 'POST', body: '{}' });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('{"message":"throttled"}');
  });

  it('EMF 派生が失敗しても転送は成功する (壊れた JSON)', async () => {
    const { app, calls, emitted } = makeApp({ status: 200, body: '{}' });
    const res = await app.request('/v1/metrics', { method: 'POST', body: 'not-json' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(emitted).toHaveLength(0);
  });
});
