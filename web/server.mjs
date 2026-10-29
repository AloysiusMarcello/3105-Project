// Zero-dependency static server for the E3 Navigator web app.
//
//   npm start            http://localhost:8080          (laptop; localhost counts as secure)
//   npm run start:https  https://<laptop-ip>:8443       (phone on the same Wi-Fi; accept the warning once)
//
// Set PORT to use another port.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDevCert } from './devcert.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const useHttps = process.argv.includes('--https');
const port = Number(process.env.PORT) || (useHttps ? 8443 : 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/** Reuses the saved certificate unless this laptop now has an address it does not cover. */
function devCert() {
  const dir = join(root, '.cert');
  const hosts = ['localhost', '127.0.0.1', ...lanAddresses()];
  const files = { key: join(dir, 'key.pem'), cert: join(dir, 'cert.pem'), hosts: join(dir, 'hosts.json') };
  if (existsSync(files.cert) && existsSync(files.hosts)) {
    const saved = JSON.parse(readFileSync(files.hosts, 'utf8'));
    if (hosts.every((h) => saved.includes(h))) return { key: readFileSync(files.key), cert: readFileSync(files.cert) };
  }
  mkdirSync(dir, { recursive: true });
  const { key, cert } = makeDevCert(hosts);
  writeFileSync(files.key, key);
  writeFileSync(files.cert, cert);
  writeFileSync(files.hosts, JSON.stringify(hosts));
  console.log(`Created a self-signed certificate in ${dir}`);
  return { key, cert };
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    // Stay inside the web folder and never serve dot-folders (the certificate's private key lives in .cert).
    if (!file.startsWith(root) || file.slice(root.length).split(sep).some((p) => p.startsWith('.'))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${rel}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // always serve the latest edit while developing
    });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
  if (process.env.LOG_REQUESTS) console.log(req.method, req.url, res.statusCode);
}

const server = useHttps ? createHttps(devCert(), handle) : createHttp(handle);
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try: PORT=${port + 1} npm start` : e.message);
  process.exit(1);
});
server.listen(port, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log(`E3 Navigator web app on ${scheme}://localhost:${port}`);
  if (useHttps) {
    for (const ip of lanAddresses()) console.log(`  phone on the same Wi-Fi: ${scheme}://${ip}:${port}`);
    console.log('  The phone will warn that the certificate is not trusted: choose Advanced -> Proceed.');
  } else {
    console.log('  Phones need https for the camera and sensors: run "npm run start:https" instead.');
  }
});
