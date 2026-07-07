// OTLP (http/json) ペイロードから CloudWatch EMF レコードを導出する純関数群。
//
// 目的: CloudWatch OTLP ストア (PromQL) は 1 クエリ最大 7 日のため、長期トレンド
// 用に Classic メトリクス (15 ヶ月保持) を EMF 経由で複製する。
//
// 計測ポリシー (グッドハートの法則対応、docs のテンプレート紹介を参照):
// - 個人別 (user.email 等) の次元は作らない
// - 量産系・生産性系 (lines_of_code / active_time / session / commit / PR) は
//   長期化しない
// - 対象は品質 (ToolCalls/ToolFailures) とキャパシティ (Cost/Tokens) のみ

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

interface OtlpNumberDataPoint {
  // OTLP JSON では int64 は文字列で表現される
  asInt?: string | number;
  asDouble?: number;
  attributes?: OtlpKeyValue[];
}

interface OtlpMetric {
  name: string;
  sum?: { dataPoints?: OtlpNumberDataPoint[] };
  gauge?: { dataPoints?: OtlpNumberDataPoint[] };
}

export interface OtlpMetricsPayload {
  resourceMetrics?: Array<{
    scopeMetrics?: Array<{ metrics?: OtlpMetric[] }>;
  }>;
}

export interface OtlpLogRecord {
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
}

export interface OtlpLogsPayload {
  resourceLogs?: Array<{
    scopeLogs?: Array<{ logRecords?: OtlpLogRecord[] }>;
  }>;
}

export type EmfRecord = Record<string, unknown>;

const dataPointValue = (dp: OtlpNumberDataPoint): number => {
  if (dp.asDouble !== undefined) return dp.asDouble;
  // 属性値・データポイント値とも文字列で届くことがあるため Number() で正規化する
  const n = Number(dp.asInt);
  return Number.isFinite(n) ? n : 0;
};

const attrString = (attributes: OtlpKeyValue[] | undefined, key: string): string | undefined => {
  const found = attributes?.find((a) => a.key === key)?.value;
  if (found === undefined) return undefined;
  if (found.stringValue !== undefined) return found.stringValue;
  if (found.boolValue !== undefined) return String(found.boolValue);
  return undefined;
};

const emfRecord = (
  namespace: string,
  timestamp: number,
  metrics: Record<string, number>,
  dimensions: Record<string, string> = {}
): EmfRecord => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: namespace,
        Dimensions: [Object.keys(dimensions)],
        Metrics: Object.keys(metrics).map((name) => ({ Name: name, Unit: 'None' })),
      },
    ],
  },
  ...dimensions,
  ...metrics,
});

const iterMetrics = (payload: OtlpMetricsPayload): OtlpMetric[] =>
  (payload.resourceMetrics ?? []).flatMap((rm) =>
    (rm.scopeMetrics ?? []).flatMap((sm) => sm.metrics ?? [])
  );

const sumBy = (metric: OtlpMetric, key?: string): Map<string, number> => {
  const totals = new Map<string, number>();
  const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
  for (const dp of dataPoints) {
    const group = key ? (attrString(dp.attributes, key) ?? 'unknown') : '';
    totals.set(group, (totals.get(group) ?? 0) + dataPointValue(dp));
  }
  return totals;
};

// OTLP metrics ペイロード → EMF。対象メトリクスのみ拾い、それ以外は無視する
export const metricsToEmf = (
  payload: OtlpMetricsPayload,
  namespace: string,
  timestamp: number
): EmfRecord[] => {
  const records: EmfRecord[] = [];
  const scalars: Record<string, number> = {};

  for (const metric of iterMetrics(payload)) {
    switch (metric.name) {
      case 'claude_code.cost.usage': {
        const total = sumBy(metric).get('') ?? 0;
        if (total > 0) scalars.Cost = (scalars.Cost ?? 0) + total;
        break;
      }
      case 'claude_code.token.usage': {
        for (const [type, total] of sumBy(metric, 'type')) {
          if (total > 0) records.push(emfRecord(namespace, timestamp, { Tokens: total }, { type }));
        }
        break;
      }
      default:
        break;
    }
  }

  if (Object.keys(scalars).length > 0) {
    records.push(emfRecord(namespace, timestamp, scalars));
  }
  return records;
};

// OTLP logs ペイロード → EMF。tool_result イベントから呼出数と失敗数を集計する
export const logsToEmf = (
  payload: OtlpLogsPayload,
  namespace: string,
  timestamp: number
): EmfRecord[] => {
  let calls = 0;
  let failures = 0;

  for (const rl of payload.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const record of sl.logRecords ?? []) {
        if (record.body?.stringValue !== 'claude_code.tool_result') continue;
        calls += 1;
        // success 属性は文字列 "true"/"false" で届く (2026-07-06 実測)
        if (attrString(record.attributes, 'success') === 'false') failures += 1;
      }
    }
  }

  if (calls === 0) return [];
  return [emfRecord(namespace, timestamp, { ToolCalls: calls, ToolFailures: failures })];
};
