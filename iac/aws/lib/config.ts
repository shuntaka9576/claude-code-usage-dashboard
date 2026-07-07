export interface OtlpIngestConfig {
  apiName: string;
  stageName: string;
  throttle: {
    rateLimit: number;
    burstLimit: number;
  };
  // WAF の IP 許可リスト。IP 制限したい場合は自分の送信元 IP に置き換える
  allowedIps: string[];
}

export interface AppConfig {
  region: string;
  logGroupName: string;
  logStreamName: string;
  dashboardName: string;
  // Lambda が EMF で出力する Classic メトリクスの namespace (長期観測用)
  metricsNamespace: string;
  longtermDashboardName: string;
  otlpIngest: OtlpIngestConfig;
}

export const getConfig = (): AppConfig => ({
  region: 'ap-northeast-1',
  logGroupName: '/claude-code/events',
  logStreamName: 'default',
  // ops = 直近の運用・診断 (PromQL + Logs Insights)、trends = 長期トレンド (Classic)
  dashboardName: 'claude-code-ops',
  metricsNamespace: 'claude-code',
  longtermDashboardName: 'claude-code-trends',
  otlpIngest: {
    apiName: 'claude-code-otlp-ingest',
    stageName: 'prd',
    throttle: {
      rateLimit: 50,
      burstLimit: 100,
    },
    // 一旦全開放 (api key + usage plan で保護)。絞る枠組みだけ残す
    allowedIps: ['0.0.0.0/1', '128.0.0.0/1'],
  },
});
