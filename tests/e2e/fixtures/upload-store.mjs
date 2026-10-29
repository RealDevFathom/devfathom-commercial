// Disposable S3-compatible transport for browser acceptance only. The app still
// exercises its real upload authorization, validation, S3 SDK and private-file
// delivery. No production storage policy or local-adapter exception is needed.
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('A dedicated upload fixture port is required.');
}
const objects = new Map();
createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && path === '/health') {
    response.end('ready');
    return;
  }
  if (!path.startsWith('/browser-evidence/')) {
    response.writeHead(404).end();
    return;
  }
  if (request.method === 'PUT') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    objects.set(path, {
      body: Buffer.concat(chunks),
      contentType: request.headers['content-type'] ?? 'application/octet-stream',
    });
    response.writeHead(200, { ETag: '"browser-evidence"' }).end();
    return;
  }
  if (request.method === 'DELETE') {
    objects.delete(path);
    response.writeHead(204).end();
    return;
  }
  const object = objects.get(path);
  if (request.method === 'GET' && object) {
    response
      .writeHead(200, {
        'Content-Type': object.contentType,
        'Content-Length': object.body.length,
      })
      .end(object.body);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/xml' });
  response.end('<Error><Code>NoSuchKey</Code></Error>');
}).listen(port, '127.0.0.1');
