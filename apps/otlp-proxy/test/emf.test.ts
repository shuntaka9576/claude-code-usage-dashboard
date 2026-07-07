import { logsToEmf, metricsToEmf } from '../src/emf.js';

const NS = 'claude-code';
const TS = 1700000000000;

describe('metricsToEmf', () => {
  it('対象メトリクスをEMFレコードに変換する (int64文字列の数値変換込み)', () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                { name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 0.12 }] } },
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    dataPoints: [
                      // OTLP JSON の int64 は文字列で届く
                      {
                        asInt: '100',
                        attributes: [{ key: 'type', value: { stringValue: 'input' } }],
                      },
                      {
                        asInt: '50',
                        attributes: [{ key: 'type', value: { stringValue: 'output' } }],
                      },
                      {
                        asInt: '30',
                        attributes: [{ key: 'type', value: { stringValue: 'output' } }],
                      },
                    ],
                  },
                },
                // 対象外 (量産系・生産性系) は無視される
                { name: 'claude_code.commit.count', sum: { dataPoints: [{ asInt: 2 }] } },
                { name: 'claude_code.pull_request.count', sum: { dataPoints: [{ asInt: '1' }] } },
                {
                  name: 'claude_code.code_edit_tool.decision',
                  sum: {
                    dataPoints: [
                      {
                        asInt: '3',
                        attributes: [{ key: 'decision', value: { stringValue: 'accept' } }],
                      },
                    ],
                  },
                },
                { name: 'claude_code.session.count', sum: { dataPoints: [{ asInt: '1' }] } },
                { name: 'claude_code.lines_of_code.count', sum: { dataPoints: [{ asInt: '99' }] } },
              ],
            },
          ],
        },
      ],
    };

    const records = metricsToEmf(payload, NS, TS);

    const tokens = records.filter((r) => 'Tokens' in r);
    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'input', Tokens: 100 }),
        expect.objectContaining({ type: 'output', Tokens: 80 }),
      ])
    );
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ Cost: 0.12 })]));
    // 量産系・生産性系は変換されない
    const flat = JSON.stringify(records);
    expect(flat).not.toContain('Commits');
    expect(flat).not.toContain('PullRequests');
    expect(flat).not.toContain('EditDecisions');
    expect(flat).not.toContain('Sessions');
    expect(flat).not.toContain('LinesOfCode');
    // EMF メタデータの形
    const withDim = records.find((r) => 'type' in r) as Record<string, unknown>;
    expect(withDim._aws).toMatchObject({
      Timestamp: TS,
      CloudWatchMetrics: [{ Namespace: NS, Dimensions: [['type']] }],
    });
  });

  it('空・不正なペイロードでは何も出さない', () => {
    expect(metricsToEmf({}, NS, TS)).toEqual([]);
    expect(metricsToEmf({ resourceMetrics: [{}] }, NS, TS)).toEqual([]);
  });
});

describe('logsToEmf', () => {
  it('tool_result イベントから呼出数と失敗数を集計する (success は文字列)', () => {
    const record = (success: string) => ({
      body: { stringValue: 'claude_code.tool_result' },
      attributes: [{ key: 'success', value: { stringValue: success } }],
    });
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                record('true'),
                record('true'),
                record('false'),
                // tool_result 以外は無視
                { body: { stringValue: 'claude_code.api_request' } },
              ],
            },
          ],
        },
      ],
    };

    const records = logsToEmf(payload, NS, TS);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ToolCalls: 3, ToolFailures: 1 });
  });

  it('tool_result が無ければ何も出さない', () => {
    expect(logsToEmf({}, NS, TS)).toEqual([]);
  });
});
