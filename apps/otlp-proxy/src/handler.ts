import { handle } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { envCredentials } from './forward.js';

const app = createApp({
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
  eventsLogGroup: process.env.EVENTS_LOG_GROUP ?? '/claude-code/events',
  eventsLogStream: process.env.EVENTS_LOG_STREAM ?? 'default',
  metricsNamespace: process.env.METRICS_NAMESPACE ?? 'claude-code',
  credentials: envCredentials(),
});

export const handler = handle(app);
