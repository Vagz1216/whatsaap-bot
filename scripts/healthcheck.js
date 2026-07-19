import http from 'http';

const port = Number(process.env.WEBHOOK_PORT || process.env.PORT || 3100);
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 5000);

const req = http.get({
  host: '127.0.0.1',
  port,
  path: '/health',
  timeout: timeoutMs
}, (res) => {
  let raw = '';
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(raw || JSON.stringify({ status: 'ok' }));
      return;
    }
    console.error(JSON.stringify({ status: 'error', statusCode: res.statusCode, body: raw }));
    process.exit(1);
  });
});

req.on('timeout', () => {
  req.destroy(new Error('healthcheck_timeout'));
});

req.on('error', (error) => {
  console.error(JSON.stringify({ status: 'error', message: error.message }));
  process.exit(1);
});
