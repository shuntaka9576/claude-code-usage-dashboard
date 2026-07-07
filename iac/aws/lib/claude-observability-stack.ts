import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { type AppConfig, getConfig } from './config.js';
import { LongtermDashboard } from './longterm-dashboard.js';
import { OtlpIngestApi } from './otlp-ingest-api.js';
import { PromqlChartWidget, type PromqlQuery } from './widgets/promql-chart-widget.js';

// Claude Code の組み込み OTLP テレメトリを可視化するダッシュボード。
//
// メトリクスは CloudWatch OTel Metrics (OTLP ネイティブ取り込み) に格納され、
// PromQL で参照する。collector/otel-config.yaml の otlphttp/cw-metrics exporter の
// 送信先と対応する。
//
// PromQL 上の見え方:
// - ドット入りメトリクス名は {"claude_code.token.usage", ...} の引用構文で参照
// - resource 属性は "@resource.service.name" 等のラベルとして付与される
// - PromQL は 1 クエリの時間範囲が最大 7 日 (実測ハードリミット 8 日)。
//   このダッシュボードは直近ビュー用と割り切り、長期分析は
//   ロググループ /claude-code/events (retention 13 ヶ月) を Logs Insights で引く。
//
// delta temporality (settings.json の OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE)
// 前提で increase() を使う。rate window はセッション中のエクスポート間隔
// (デフォルト 60 秒) でも複数サンプル入るよう 15m にしている。

const CC_RESOURCE = '"@resource.service.name"="claude-code"';

const ccIncrease = (id: string, metricName: string, label?: string): PromqlQuery => ({
  id,
  label: label ?? `${metricName} (15m)`,
  query: `sum(increase({"${metricName}", ${CC_RESOURCE}}[15m]))`,
});

// sum by のグループ値がそのまま凡例になるため label は付けない
const ccIncreaseBy = (id: string, metricName: string, by: string): PromqlQuery => ({
  id,
  query: `sum by (${by})(increase({"${metricName}", ${CC_RESOURCE}}[15m]))`,
});

export class ClaudeObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps & { config?: AppConfig }) {
    super(scope, id, props);
    const config = props?.config ?? getConfig();

    // OTLP logs エンドポイントは x-aws-log-group / x-aws-log-stream ヘッダーで
    // 宛先を指定する (APIG 統合が付与)。両方とも事前に存在している必要がある
    const eventsLogGroup = new logs.LogGroup(this, 'EventsLogGroup', {
      logGroupName: config.logGroupName,
      retention: logs.RetentionDays.THIRTEEN_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogStream(this, 'EventsLogStream', {
      logGroup: eventsLogGroup,
      logStreamName: config.logStreamName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new OtlpIngestApi(this, 'OtlpIngestApi', {
      eventsLogGroup,
      config: config.otlpIngest,
      metricsNamespace: config.metricsNamespace,
      eventsLogStreamName: config.logStreamName,
    });

    new LongtermDashboard(this, 'LongtermDashboard', {
      metricsNamespace: config.metricsNamespace,
      dashboardName: config.longtermDashboardName,
    });

    // Logs Insights のサンプルクエリ (コンソールの保存済みクエリに claude-code/
    // フォルダとして登録される)。日次集計系は PromQL の 7 日レンジ制限を補う
    // 長期分析用。フィールドパスは実データで確認済みの構造
    // (body = イベント完全名、数値・boolean 属性は文字列) を前提とする。
    const queryDefinitions: Array<{ id: string; name: string; queryString: logs.QueryString }> = [
      // 個人別 (user.email) の集計クエリは意図的に置かない。
      // 常設の個人別表示は比較・評価に転用されやすく、グッドハートの法則で
      // 指標自体が壊れるため。必要な調査はアドホックに実行する
      {
        id: 'QueryDailyCost',
        name: 'claude-code/daily-cost',
        queryString: new logs.QueryString({
          filterStatements: ["body = 'claude_code.api_request'"],
          stats: 'sum(attributes.cost_usd) as cost_usd by bin(1d) as day',
          sort: 'day desc',
        }),
      },
      {
        id: 'QueryDailyTokenUsage',
        name: 'claude-code/daily-token-usage',
        queryString: new logs.QueryString({
          filterStatements: ["body = 'claude_code.api_request'"],
          stats:
            'sum(attributes.input_tokens) as input, sum(attributes.output_tokens) as output, sum(attributes.cache_read_tokens) as cache_read, sum(attributes.cache_creation_tokens) as cache_creation by bin(1d) as day',
          sort: 'day desc',
        }),
      },
      {
        id: 'QueryToolUsageSummary',
        name: 'claude-code/tool-usage-summary',
        queryString: new logs.QueryString({
          filterStatements: ["body = 'claude_code.tool_result'"],
          stats:
            "count(*) as calls, avg(attributes.duration_ms) as avg_ms, sum(attributes.success = 'false') as failures by attributes.tool_name as tool",
          sort: 'calls desc',
        }),
      },
      {
        id: 'QuerySkillActivations',
        name: 'claude-code/skill-activations',
        queryString: new logs.QueryString({
          fields: [
            '@timestamp',
            'attributes.skill.name',
            'attributes.invocation_trigger',
            'attributes.skill.source',
          ],
          filterStatements: ["body = 'claude_code.skill_activated'"],
          sort: '@timestamp desc',
          limit: 50,
        }),
      },
      {
        id: 'QuerySkillCost',
        name: 'claude-code/skill-cost',
        queryString: new logs.QueryString({
          filterStatements: [
            "body = 'claude_code.api_request' and ispresent(attributes.skill.name)",
          ],
          stats:
            'sum(attributes.cost_usd) as cost_usd, sum(attributes.output_tokens) as output_tokens by attributes.skill.name as skill',
          sort: 'cost_usd desc',
        }),
      },
      {
        id: 'QueryApiErrors',
        name: 'claude-code/api-errors',
        queryString: new logs.QueryString({
          fields: ['@timestamp', 'attributes.model', 'attributes.error', 'attributes.status_code'],
          filterStatements: ["body = 'claude_code.api_error'"],
          sort: '@timestamp desc',
          limit: 50,
        }),
      },
    ];
    for (const q of queryDefinitions) {
      new logs.QueryDefinition(this, q.id, {
        queryDefinitionName: q.name,
        queryString: q.queryString,
        logGroups: [eventsLogGroup],
      });
    }

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: config.dashboardName,
    });

    // 計測ポリシー (SPACE / グッドハートの法則への対応):
    // - チーム集計のみ。個人別 (user.email 等) の常設表示は置かない
    //   (属性はデータに残るため、課金異常などの調査はアドホックに可能)
    // - 量産系・生産性系メトリクス (commit/PR 数、lines_of_code、active_time、
    //   session 数) は成果指標になり得ず、目標化すると歪むため掲示しない
    // - コスト・トークンは予算/キャパシティ管理の文脈に置き、効率評価や
    //   個人比較には使わない

    // 行1: キャパシティ (予算管理。チーム合計のみ)
    dashboard.addWidgets(
      new PromqlChartWidget({
        title: 'Cost (USD, team total)',
        queries: [ccIncrease('cost', 'claude_code.cost.usage', 'cost USD (15m)')],
      }),
      new PromqlChartWidget({
        title: 'Token usage (by type)',
        queries: [ccIncreaseBy('tokens', 'claude_code.token.usage', 'type')],
      }),
      new PromqlChartWidget({
        title: 'Token usage (by model)',
        queries: [ccIncreaseBy('tokensByModel', 'claude_code.token.usage', 'model')],
      })
    );

    // 行2: スキル利用 (チーム集計。何が使われているかの横展開用)
    // スキルは OTLP メトリクスに存在しないためイベントから Logs Insights で集計する
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Skill activations (by skill)',
        logGroupNames: [eventsLogGroup.logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          "filter body = 'claude_code.skill_activated'",
          'stats count(*) as activations by attributes.skill.name as skill',
          'sort activations desc',
          'limit 25',
        ],
        width: 12,
        height: 8,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Skill cost (USD, by skill)',
        logGroupNames: [eventsLogGroup.logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          "filter body = 'claude_code.api_request' and ispresent(attributes.skill.name)",
          'stats sum(attributes.cost_usd) as cost_usd, sum(attributes.output_tokens) as output_tokens by attributes.skill.name as skill',
          'sort cost_usd desc',
          'limit 25',
        ],
        width: 12,
        height: 8,
      })
    );

    // 行3: 摩擦・安定性 (システム由来の問題を見る。人の評価ではない)
    // イベント (OTLP ログ) の格納構造 (2026-07-06 実測):
    // - body = イベント完全名 ("claude_code.tool_result" 等)
    // - attributes.success 等の boolean は文字列 ("true"/"false")
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Tool failure rate (%)',
        logGroupNames: [eventsLogGroup.logGroupName],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        queryLines: [
          "filter body = 'claude_code.tool_result'",
          "stats sum(attributes.success = 'false') * 100.0 / count(*) as failure_pct by bin(1h)",
        ],
        width: 12,
        height: 8,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Tool failures (recent)',
        logGroupNames: [eventsLogGroup.logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          'fields @timestamp, attributes.tool_name, attributes.error_type, attributes.duration_ms',
          "filter body = 'claude_code.tool_result' and attributes.success = 'false'",
          'sort @timestamp desc',
          'limit 50',
        ],
        width: 12,
        height: 8,
      })
    );

    // 行4: 診断用の詳細テーブル
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'API errors (recent)',
        logGroupNames: [eventsLogGroup.logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          'fields @timestamp, attributes.model, attributes.error, attributes.status_code',
          "filter body = 'claude_code.api_error'",
          'sort @timestamp desc',
          'limit 50',
        ],
        width: 24,
        height: 8,
      })
    );
  }
}
