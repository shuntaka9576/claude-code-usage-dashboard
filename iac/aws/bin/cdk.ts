#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ClaudeObservabilityStack } from '../lib/claude-observability-stack.js';
import { getConfig } from '../lib/config.js';

const app = new cdk.App();
const config = getConfig();

new ClaudeObservabilityStack(app, 'claude-code-observability', {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? config.region,
  },
});
