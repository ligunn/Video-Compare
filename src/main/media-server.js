'use strict';
// Serves registered video files to the renderer over http://127.0.0.1:<port>/m/<token> with HTTP Range
// support (needed for seeking). Only files the user explicitly opened are reachable, each behind an
// unguessable token, and the socket is bound to loopback. CORS is open so a file:// page can upload
// the decoded frames into WebGL without tainting the canvas.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t' };

function createMediaServer() {
  const files = new Map(); // token -> { path, mime }
  let port = 0;

  const server = http.createServer((req, res) => {
    const m = /^\/m\/([0-9a-f]{32})$/.exec((req.url || '').split('?')[0]);
    const entry = m && files.get(m[1]);
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end(); }
    let size;
    try { size = fs.statSync(entry.path).size; } catch { res.writeHead(404); return res.end(); }

    const headers = { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Type': entry.mime, 'Cache-Control': 'no-store' };
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (r && (r[1] !== '' || r[2] !== '')) {
        if (r[1] === '') { start = Math.max(0, size - Number(r[2])); }
        else { start = Number(r[1]); if (r[2] !== '') end = Math.min(Number(r[2]), size - 1); }
      }
      if (!r || start > end || start >= size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(entry.path, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
      });
    },
    register(filePath) {
      const id = crypto.randomBytes(16).toString('hex');
      files.set(id, { path: path.resolve(filePath), mime: MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      return { id, url: `http://127.0.0.1:${port}/m/${id}` };
    },
    release(id) { files.delete(id); },
    close() { server.close(); },
  };
}

module.exports = { createMediaServer };
