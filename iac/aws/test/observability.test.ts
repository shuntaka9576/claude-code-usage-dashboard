import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ClaudeObservabilityStack } from '../lib/claude-observability-stack.js';

describe('ClaudeObservabilityStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new ClaudeObservabilityStack(app, 'TestClaudeObservability');
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });

  it('creates log group and stream for OTLP logs endpoint', () => {
    const app = new cdk.App();
    const stack = new ClaudeObservabilityStack(app, 'TestClaudeObservability');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/claude-code/events',
      RetentionInDays: 400,
    });
    template.hasResourceProperties('AWS::Logs::LogStream', {
      LogStreamName: 'default',
    });
  });

  it('creates OTLP ingest API with api key enforcement', () => {
    const app = new cdk.App();
    const stack = new ClaudeObservabilityStack(app, 'TestClaudeObservability');
    const template = Template.fromStack(stack);

    // /v1/metrics と /v1/logs の 2 メソッドとも api key 必須の Lambda プロキシ統合
    const methods = template.findResources('AWS::ApiGateway::Method', {
      Properties: {
        HttpMethod: 'POST',
        ApiKeyRequired: true,
        Integration: { Type: 'AWS_PROXY' },
      },
    });
    expect(Object.keys(methods)).toHaveLength(2);

    template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);

    // Lambda 実行ロール: PutMetricData と対象ロググループ限定の PutLogEvents
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          { Action: 'cloudwatch:PutMetricData', Effect: 'Allow', Resource: '*' },
          {
            Action: 'logs:PutLogEvents',
            Effect: 'Allow',
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^EventsLogGroup'), 'Arn'] },
          },
        ],
      },
    });
  });

  it('creates longterm classic dashboard', () => {
    const app = new cdk.App();
    const stack = new ClaudeObservabilityStack(app, 'TestClaudeObservability');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::CloudWatch::Dashboard', 2);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'claude-code-trends',
    });
  });
});
