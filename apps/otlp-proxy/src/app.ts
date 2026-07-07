import { Hono } from 'hono';
import { logsToEmf, metricsToEmf, type OtlpLogsPayload, type OtlpMetricsPayload } from './emf.js';
import { type AwsCredentials, forwardOtlp } from './forward.js';
import { sanitizeLogs } from './sanitize.js';

export interface OtlpProxyConfig {
  region: string;
  eventsLogGroup: string;
  eventsLogStream: string;
  metricsNamespace: string;
  credentials: AwsCredentials;
  // テスト時に注入する。省略時はグローバル fetch / console.log / Date.now
  fetchImpl?: typeof fetch;
  emit?: (line: string) => void;
  now?: () => number;
}

// APIG (Lambda プロキシ統合) の裏で OTLP を受け、
// 1. CloudWatch の OTLP エンドポイントへ SigV4 署名して素通し転送 (本体)
// 2. 同じペイロードから EMF を出力して Classic メトリクス化 (長期観測、副次)
// EMF 派生は失敗しても転送を妨げない。
export const createApp = (config: OtlpProxyConfig): Hono => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const emit = config.emit ?? ((line: string) => console.log(line));
  const now = config.now ?? Date.now;

  const emitEmf = (derive: () => ReturnType<typeof metricsToEmf>): void => {
    try {
      for (const record of derive()) emit(JSON.stringify(record));
    } catch (e) {
      console.error('[emf] derivation failed (forwarding continues):', e);
    }
  };

  const passthrough = async (upstream: Response): Promise<Response> => {
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  };

  const app = new Hono();

  app.post('/v1/metrics', async (c) => {
    const body = await c.req.text();
    emitEmf(() =>
      metricsToEmf(JSON.parse(body) as OtlpMetricsPayload, config.metricsNamespace, now())
    );
    const upstream = await forwardOtlp(
      {
        url: `https://monitoring.${config.region}.amazonaws.com/v1/metrics`,
        service: 'monitoring',
      },
      body,
      config.region,
      config.credentials,
      fetchImpl
    );
    return passthrough(upstream);
  });

  app.post('/v1/logs', async (c) => {
    const raw = await c.req.text();
    // OTEL_LOG_TOOL_DETAILS のツール詳細 (コマンド本文・パス) を転送前に除去する。
    // 失敗時は生のまま転送する (EMF 同様、本体の転送を妨げない)
    let body = raw;
    try {
      body = JSON.stringify(sanitizeLogs(JSON.parse(raw) as OtlpLogsPayload));
    } catch (e) {
      console.error('[sanitize] failed (forwarding raw):', e);
    }
    emitEmf(() => logsToEmf(JSON.parse(body) as OtlpLogsPayload, config.metricsNamespace, now()));
    const upstream = await forwardOtlp(
      {
        url: `https://logs.${config.region}.amazonaws.com/v1/logs`,
        service: 'logs',
        // 宛先ロググループ/ストリームはここで付与する (クライアント指定は不要)
        extraHeaders: {
          'x-aws-log-group': config.eventsLogGroup,
          'x-aws-log-stream': config.eventsLogStream,
        },
      },
      body,
      config.region,
      config.credentials,
      fetchImpl
    );
    return passthrough(upstream);
  });

  return app;
};
