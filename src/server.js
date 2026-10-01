'use strict';
// HTTP 服务：JSON API + 静态前端（仅 Node 内置模块）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function startServer({ service, port }) {
  // [method, 路径片段模式, handler(body, params)]
  const routes = [
    ['GET', ['api', 'state'], () => service.listState()],
    ['GET', ['api', 'orders', ':id'], (b, p) => service.orderDetail(Number(p.id))],
    ['POST', ['api', 'orders'], (b) => service.createOrder(b)],
    ['POST', ['api', 'orders', ':id', 'files'], (b, p) => service.uploadVersion(Number(p.id), b)],
    ['POST', ['api', 'orders', ':id', 'proof'], (b, p) => service.generateProof(Number(p.id))],
    ['POST', ['api', 'orders', ':id', 'rush'], (b, p) => service.setRush(Number(p.id))],
    ['POST', ['api', 'orders', ':id', 'reprints'], (b, p) => service.recordReprint(Number(p.id), b)],
    ['POST', ['api', 'orders', ':id', 'reduce'], (b, p) => service.reduceCopies(Number(p.id), b)],
    ['POST', ['api', 'orders', ':id', 'pickup'], (b, p) => service.pickup(Number(p.id), b)],
    ['POST', ['api', 'proofs', ':id', 'annotations'], (b, p) => service.addAnnotation(Number(p.id), b)],
    ['POST', ['api', 'proofs', ':id', 'confirm'], (b, p) => service.confirmProof(Number(p.id))],
    ['POST', ['api', 'proofs', ':id', 'reject'], (b, p) => service.rejectProof(Number(p.id), b.note)],
    ['POST', ['api', 'tasks', ':id', 'claim'], (b, p) => service.claimTask(Number(p.id), b.operator)],
    ['POST', ['api', 'tasks', ':id', 'finish'], (b, p) => service.finishTask(Number(p.id), b.operator)],
    ['POST', ['api', 'devices', ':id', 'jam'], (b, p) => service.jamDevice(Number(p.id))],
    ['POST', ['api', 'devices', ':id', 'clear'], (b, p) => service.clearDevice(Number(p.id))],
    ['GET', ['api', 'samples'], () => fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.json'))],
    ['GET', ['api', 'samples', ':name'], (b, p) => {
      const file = path.join(SAMPLES_DIR, path.basename(p.name));
      if (!fs.existsSync(file)) { const e = new Error('样本不存在'); e.status = 404; throw e; }
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (segs[0] === 'api') {
        const body = await readBody(req);
        for (const [method, pattern, handler] of routes) {
          if (method !== req.method || pattern.length !== segs.length) continue;
          const params = {};
          const ok = pattern.every((seg, i) => seg.startsWith(':') ? (params[seg.slice(1)] = segs[i], true) : seg === segs[i]);
          if (!ok) continue;
          const result = await handler(body, params);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result));
        }
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '接口不存在' }));
      }
      // 静态文件
      const rel = segs.length === 0 ? 'index.html' : segs.join('/');
      const file = path.join(PUBLIC_DIR, path.normalize(rel));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(port, () => console.log(`图文店打印系统已启动: http://localhost:${port}`));
  return server;
}

module.exports = { startServer };
