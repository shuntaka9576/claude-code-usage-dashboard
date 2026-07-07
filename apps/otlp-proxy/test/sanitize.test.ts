import type { OtlpKeyValue, OtlpLogsPayload } from '../src/emf.js';
import { sanitizeLogs } from '../src/sanitize.js';

const payloadWith = (attributes: OtlpKeyValue[]): OtlpLogsPayload => ({
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [{ body: { stringValue: 'claude_code.tool_result' }, attributes }],
        },
      ],
    },
  ],
});

const firstAttributes = (payload: OtlpLogsPayload): OtlpKeyValue[] =>
  payload.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]?.attributes ?? [];

describe('sanitizeLogs', () => {
  it('tool_parameters から識別子だけ残して本文を落とす', () => {
    const payload = payloadWith([
      { key: 'tool_name', value: { stringValue: 'Task' } },
      {
        key: 'tool_parameters',
        value: {
          stringValue: JSON.stringify({
            subagent_type: 'general-purpose',
            mcp_server_name: 'slack',
            command: 'rm -rf /tmp/secret',
            file_path: '/Users/me/repo/secret.ts',
          }),
        },
      },
    ]);

    const attrs = firstAttributes(sanitizeLogs(payload));
    const toolParameters = attrs.find((a) => a.key === 'tool_parameters');
    expect(JSON.parse(toolParameters?.value?.stringValue ?? '{}')).toEqual({
      subagent_type: 'general-purpose',
      mcp_server_name: 'slack',
    });
    // 識別子以外の属性は素通し
    expect(attrs.find((a) => a.key === 'tool_name')?.value?.stringValue).toBe('Task');
    const flat = JSON.stringify(attrs);
    expect(flat).not.toContain('rm -rf');
    expect(flat).not.toContain('secret.ts');
  });

  it('残す識別子が無い tool_parameters は属性ごと落とす', () => {
    const payload = payloadWith([
      {
        key: 'tool_parameters',
        value: { stringValue: JSON.stringify({ command: 'cat ~/.ssh/id_rsa' }) },
      },
    ]);
    expect(firstAttributes(sanitizeLogs(payload))).toEqual([]);
  });

  it('パース不能・文字列以外の tool_parameters は落とす', () => {
    expect(
      firstAttributes(sanitizeLogs(payloadWith([{ key: 'tool_parameters', value: { stringValue: 'not-json' } }])))
    ).toEqual([]);
    expect(
      firstAttributes(sanitizeLogs(payloadWith([{ key: 'tool_parameters', value: { intValue: 1 } }])))
    ).toEqual([]);
  });

  it('tool_parameters を含まないレコードとペイロード外形は変更しない', () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'claude_code.api_request' },
                  attributes: [{ key: 'cost_usd', value: { doubleValue: 0.1 } }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(sanitizeLogs(payload)).toEqual(payload);
    expect(sanitizeLogs({})).toEqual({});
  });
});
