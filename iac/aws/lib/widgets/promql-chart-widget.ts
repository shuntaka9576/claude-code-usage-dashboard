import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

export interface PromqlQuery {
  id: string;
  query: string;
  label?: string;
}

// CDK L2 (GraphWidget) は Classic メトリクス専用のため、dashboard body の
// `type: chart` ウィジェット (PromQL 対応) を直接出力する薄いラッパー。
export class PromqlChartWidget extends cloudwatch.ConcreteWidget {
  private readonly title: string;
  private readonly queries: PromqlQuery[];

  constructor(props: { title: string; queries: PromqlQuery[]; width?: number; height?: number }) {
    super(props.width ?? 8, props.height ?? 6);
    this.title = props.title;
    this.queries = props.queries;
  }

  toJson(): Record<string, unknown>[] {
    return [
      {
        type: 'chart',
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        properties: {
          view: 'line',
          title: this.title,
          region: cdk.Aws.REGION,
          data: {
            queries: this.queries.map((q) => ({
              id: q.id,
              type: 'cloudwatch-metrics',
              language: 'PromQL',
              query: q.query,
              ...(q.label ? { label: q.label } : {}),
            })),
          },
          // ドキュメント上は省略可だが、無いとコンソールのレンダラーが
          // style.markOptions 参照で落ちて "Something went wrong" になる
          // (2026-07 時点の実測)。明示的にデフォルト相当を指定する。
          plotOptions: {
            legend: { position: 'bottom', show: true },
            style: {
              lineOptions: {
                width: 2,
                pattern: 'solid',
                spline: false,
                filled: false,
                stacked: false,
              },
              markOptions: { enabled: false },
            },
          },
        },
      },
    ];
  }
}
