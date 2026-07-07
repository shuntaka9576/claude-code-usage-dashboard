import type { OtlpKeyValue, OtlpLogRecord, OtlpLogsPayload } from './emf.js';

// OTEL_LOG_TOOL_DETAILS=1 を有効にすると、tool_result 等の attributes に
// tool_parameters (Bash コマンド本文・ファイルパス等を含む JSON 文字列) が乗る。
// スキル別・subagent 別・MCP 別の集計に必要な識別子だけを残し、本文は
// ロググループに入る前にここで落とす。別 Lambda + Raw/Sanitized の 2 段構成に
// せず、全ペイロードが必ず通るこのプロキシで転送前にインライン処理する。
//
// 方針: tool_parameters は識別子の allowlist 抽出、それ以外の属性は素通し。
// 個人・セッション属性 (user.email 等) はアドホック調査用に意図的に残す
// (README の計測ポリシー参照)。

const TOOL_PARAMETER_KEEP = new Set(['subagent_type', 'mcp_server_name', 'skill_name']);

const sanitizeToolParameters = (kv: OtlpKeyValue): OtlpKeyValue | undefined => {
  const raw = kv.value?.stringValue;
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // パース不能な詳細は残さない (安全側に倒す)
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const kept = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([key]) =>
      TOOL_PARAMETER_KEEP.has(key)
    )
  );
  if (Object.keys(kept).length === 0) return undefined;
  return { key: kv.key, value: { stringValue: JSON.stringify(kept) } };
};

const sanitizeRecord = (record: OtlpLogRecord): OtlpLogRecord => {
  if (!record.attributes) return record;
  return {
    ...record,
    attributes: record.attributes.flatMap((kv) => {
      if (kv.key !== 'tool_parameters') return [kv];
      const sanitized = sanitizeToolParameters(kv);
      return sanitized ? [sanitized] : [];
    }),
  };
};

export const sanitizeLogs = (payload: OtlpLogsPayload): OtlpLogsPayload => {
  if (!payload.resourceLogs) return payload;
  return {
    ...payload,
    resourceLogs: payload.resourceLogs.map((rl) => {
      if (!rl.scopeLogs) return rl;
      return {
        ...rl,
        scopeLogs: rl.scopeLogs.map((sl) => {
          if (!sl.logRecords) return sl;
          return { ...sl, logRecords: sl.logRecords.map(sanitizeRecord) };
        }),
      };
    }),
  };
};
