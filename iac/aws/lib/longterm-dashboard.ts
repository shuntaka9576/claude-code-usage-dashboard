import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

// 長期トレンド用ダッシュボード (Classic メトリクス、15 ヶ月保持)。
//
// データ源は otlp-proxy Lambda が EMF で出力する Classic メトリクス。
// PromQL は OTLP ストア専用で Classic には使えないため、こちらは標準の
// GraphWidget + MathExpression (Metric Math) で構成する。
// 短期詳細 (直近 7 日以内) は PromQL 側のダッシュボードを参照。
//
// 計測ポリシーは短期側と同一 (個人別なし・量産系/生産性系なし)。
export class LongtermDashboard extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: { metricsNamespace: string; dashboardName: string }
  ) {
    super(scope, id);

    const daily = (
      metricName: string,
      dimensionsMap?: Record<string, string>
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: props.metricsNamespace,
        metricName,
        dimensionsMap,
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      });

    // 疎なメトリクス (ツール呼び出しの無い日など) は FILL で 0 埋めして比率を安定させる
    const ratePercent = (
      label: string,
      numerator: cloudwatch.Metric,
      denominatorParts: cloudwatch.Metric[]
    ): cloudwatch.MathExpression =>
      new cloudwatch.MathExpression({
        label,
        expression: `100 * FILL(num, 0) / (${denominatorParts.map((_, i) => `FILL(d${i}, 0)`).join(' + ')})`,
        usingMetrics: {
          num: numerator,
          ...Object.fromEntries(denominatorParts.map((m, i) => [`d${i}`, m])),
        },
        period: cdk.Duration.days(1),
      });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: props.dashboardName,
      defaultInterval: cdk.Duration.days(90),
    });

    // 行1: キャパシティ (予算管理。チーム合計のみ)
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Cost (USD, daily)',
        width: 12,
        height: 6,
        left: [daily('Cost')],
      }),
      new cloudwatch.GraphWidget({
        title: 'Tokens by type (daily)',
        width: 12,
        height: 6,
        left: ['input', 'output', 'cacheRead', 'cacheCreation'].map((type) =>
          daily('Tokens', { type })
        ),
      })
    );

    // 行2: 摩擦・安定性
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Tool failure rate (%, daily)',
        width: 24,
        height: 6,
        left: [ratePercent('failure %', daily('ToolFailures'), [daily('ToolCalls')])],
        leftYAxis: { min: 0 },
      })
    );
  }
}
