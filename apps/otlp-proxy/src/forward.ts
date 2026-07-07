import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ForwardTarget {
  url: string;
  // SigV4 の service 名 (monitoring / logs)
  service: string;
  extraHeaders?: Record<string, string>;
}

// OTLP ボディを CloudWatch の OTLP エンドポイントへ SigV4 署名して素通し転送する
export const forwardOtlp = async (
  target: ForwardTarget,
  body: string,
  region: string,
  credentials: AwsCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<Response> => {
  const url = new URL(target.url);
  const signer = new SignatureV4({
    credentials,
    region,
    service: target.service,
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      host: url.hostname,
      'content-type': 'application/json',
      ...target.extraHeaders,
    },
    body,
  });

  const signed = await signer.sign(request);
  return fetchImpl(target.url, {
    method: 'POST',
    headers: signed.headers,
    body,
  });
};

export const envCredentials = (): AwsCredentials => ({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  sessionToken: process.env.AWS_SESSION_TOKEN,
});
