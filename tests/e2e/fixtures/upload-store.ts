import path from 'node:path';

/** Each managed app has its own loopback-only, process-lifetime object store. */
export function browserUploadStore(appPort: number) {
  const port = appPort + 1;
  return {
    server: {
      command: `node tests/e2e/fixtures/upload-store.mjs ${port}`,
      cwd: path.resolve(__dirname, '../../..'),
      url: `http://127.0.0.1:${port}/health`,
      reuseExistingServer: false,
    },
    env: {
      STORAGE_ADAPTER: 's3',
      S3_UPLOADS_BUCKET: 'browser-evidence',
      AWS_REGION: 'us-east-1',
      AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${port}`,
      AWS_ACCESS_KEY_ID: 'browser-fixture-only',
      AWS_SECRET_ACCESS_KEY: 'browser-fixture-only',
      // Keep the synthetic transport's body unframed; SDK signing still runs.
      AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED',
    },
  };
}
