// オンライン協力プレイの通信（Cloudflare Worker の部屋に WebSocket で接続する）
import { MP_SERVER } from './config.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

// 接続先。?server= で上書きできる。GitHub Pages など Worker 以外から配信している場合は config.js の値を使う
export function serverBase() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q.replace(/\/$/, '');
  if (MP_SERVER) return MP_SERVER.replace(/\/$/, '');
  if (location.protocol === 'file:' || location.hostname.endsWith('github.io')) return '';
  return location.origin;
}

export class Net {
  constructor({ room, create, name, onMessage, onClose }) {
    this.room = room;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.closed = false;
    const base = serverBase().replace(/^http/, 'ws');
    const params = new URLSearchParams({ name: name || '' });
    if (create) params.set('create', '1');
    this.ws = new WebSocket(`${base}/room/${room}?${params}`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onmessage = (e) => {
        const data = e.data;
        if (typeof data !== 'string') return;
        if (data[0] === 'S') { this.onMessage({ t: 'snap', d: JSON.parse(data.slice(1)) }); return; }
        let msg;
        try { msg = JSON.parse(data); } catch (err) { return; }
        if (msg.t === 'welcome') { this.id = msg.id; this.host = msg.host; resolve(msg); return; }
        if (msg.t === 'error') { reject(new Error(msg.reason)); return; }
        this.onMessage(msg);
      };
      this.ws.onerror = () => reject(new Error('connect_failed'));
      this.ws.onclose = () => {
        reject(new Error('closed'));
        if (!this.closed) this.onClose?.();
        this.closed = true;
      };
    });
  }

  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  sendRaw(str) { if (this.ws.readyState === 1) this.ws.send(str); }

  close() { this.closed = true; try { this.ws.close(); } catch (e) { /* noop */ } }
}
