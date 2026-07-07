import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import type { OtlpIngestConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Claude Code の OTLP テレメトリを受けて CloudWatch へ転送するプロキシ。
//
// フロントは APIG (api key + usage plan + WAF)。裏は Hono (Lambda プロキシ統合) で、
// 1. CloudWatch OTLP エンドポイント (SigV4 必須) への署名付き素通し転送
// 2. 同一ペイロードからの EMF 出力 → Classic メトリクス化 (長期観測用)
// を行う。実装は apps/otlp-proxy (別 workspace) を参照。
//
// クライアント側の制約: OTLP は http/json にすること (EMF 派生で JSON パース
// するため。protobuf 対応は proto ライブラリが必要になるだけで利点が無い)。
export class OtlpIngestApi extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      eventsLogGroup: logs.ILogGroup;
      config: OtlpIngestConfig;
      metricsNamespace: string;
      eventsLogStreamName: string;
    }
  ) {
    super(scope, id);
    const { config } = props;

    const proxyFn = new nodejs.NodejsFunction(this, 'ProxyFn', {
      entry: path.join(__dirname, '../../../apps/otlp-proxy/src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: {
        EVENTS_LOG_GROUP: props.eventsLogGroup.logGroupName,
        EVENTS_LOG_STREAM: props.eventsLogStreamName,
        METRICS_NAMESPACE: props.metricsNamespace,
      },
      // EMF の輸送路なので保持は短期で良い
      logGroup: new logs.LogGroup(this, 'ProxyFnLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        // ランタイム同梱 SDK に依存せず自己完結バンドルにする
        externalModules: [],
      },
    });
    proxyFn.addToRolePolicy(
      new iam.PolicyStatement({
        // OTLP metrics エンドポイントの認可は PutMetricData。namespace 単位の
        // リソース絞り込みは効かないため Resource は * とする
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );
    proxyFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:PutLogEvents'],
        // logGroupArn は ':*' 付きで log-stream まで包含する
        resources: [props.eventsLogGroup.logGroupArn],
      })
    );

    const api = new apigateway.RestApi(this, 'RestApi', {
      restApiName: config.apiName,
      description: 'OTLP proxy for Claude Code telemetry (Hono on Lambda, SigV4 forwarding)',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: config.stageName,
        throttlingRateLimit: config.throttle.rateLimit,
        throttlingBurstLimit: config.throttle.burstLimit,
      },
    });

    // OTLP エクスポーターは OTEL_EXPORTER_OTLP_ENDPOINT に /v1/metrics /v1/logs を
    // 自動付与するため、ルート構造をエンドポイントのパスと一致させる
    const integration = new apigateway.LambdaIntegration(proxyFn);
    const v1 = api.root.addResource('v1');
    v1.addResource('metrics').addMethod('POST', integration, { apiKeyRequired: true });
    v1.addResource('logs').addMethod('POST', integration, { apiKeyRequired: true });

    // IP 制限 (WAFv2)。api key 認証に加えて送信元 IP を許可リストで絞る。
    // 許可 IP 以外は APIG に届く前に 403 でブロックされる
    const ipSet = new wafv2.CfnIPSet(this, 'AllowedIpSet', {
      name: `${config.apiName}-allowed-ips`,
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: config.allowedIps,
    });

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: config.apiName,
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: config.apiName,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'allow-listed-ips',
          priority: 0,
          action: { allow: {} },
          statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'allow-listed-ips',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: `arn:aws:apigateway:${cdk.Aws.REGION}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`,
      webAclArn: webAcl.attrArn,
    });

    const apiKey = api.addApiKey('ApiKey', {
      apiKeyName: config.apiName,
    });
    const usagePlan = api.addUsagePlan('UsagePlan', {
      name: config.apiName,
      throttle: {
        rateLimit: config.throttle.rateLimit,
        burstLimit: config.throttle.burstLimit,
      },
    });
    usagePlan.addApiStage({ stage: api.deploymentStage });
    usagePlan.addApiKey(apiKey);

    new cdk.CfnOutput(this, 'OtlpEndpoint', {
      // 末尾スラッシュ無し。この値をそのまま OTEL_EXPORTER_OTLP_ENDPOINT に設定する
      value: `https://${api.restApiId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/${api.deploymentStage.stageName}`,
    });
    new cdk.CfnOutput(this, 'ApiKeyId', {
      // 値の取得: aws apigateway get-api-key --api-key <ID> --include-value --query value
      value: apiKey.keyId,
    });
  }
}
