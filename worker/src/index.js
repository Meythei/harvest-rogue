// ハーベスト・ローグ オンライン協力プレイ用サーバー
// ホストのブラウザがゲームを計算し、この Worker（部屋ごとの Durable Object）がメッセージを中継する。
import { DurableObject } from 'cloudflare:workers';

const MAX_PEERS = 4;
const ROOM_RE = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!ROOM_RE.test(code)) return new Response('bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    if (url.pathname === '/health') return new Response('ok');
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const create = url.searchParams.get('create') === '1';
    const name = (url.searchParams.get('name') || '').slice(0, 12);
    const peers = this.ctx.getWebSockets();
    const host = peers.find((ws) => ws.deserializeAttachment()?.host);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const reject = (reason) => {
      server.send(JSON.stringify({ t: 'error', reason }));
      server.close(4000, reason);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (create && host) return reject('room_taken');
    if (!create && !host) return reject('no_room');
    if (peers.length >= MAX_PEERS) return reject('full');

    const nextId = ((await this.ctx.storage.get('nextId')) || 1);
    await this.ctx.storage.put('nextId', nextId + 1);
    const me = { id: nextId, host: create, name };
    server.serializeAttachment(me);
    server.send(JSON.stringify({ t: 'welcome', id: me.id, host: me.host }));
    if (!create) this.sendHost(host, { t: 'peer_join', id: me.id, name });
    return new Response(null, { status: 101, webSocket: client });
  }

  sendHost(host, msg) {
    try { host.send(JSON.stringify(msg)); } catch (e) { /* 切断済み */ }
  }

  findHost() {
    return this.ctx.getWebSockets().find((ws) => ws.deserializeAttachment()?.host);
  }

  async webSocketMessage(ws, message) {
    const me = ws.deserializeAttachment();
    if (!me || typeof message !== 'string') return;
    if (me.host) {
      // ホスト → 全ゲスト（'S' で始まるのはスナップショット。中身は解釈せずそのまま配る）
      if (message[0] === 'S') {
        for (const peer of this.ctx.getWebSockets()) {
          if (peer !== ws) { try { peer.send(message); } catch (e) { /* noop */ } }
        }
        return;
      }
      // ホスト → 特定のゲスト
      let msg;
      try { msg = JSON.parse(message); } catch (e) { return; }
      if (msg.t === 'to') {
        const peer = this.ctx.getWebSockets().find((p) => p.deserializeAttachment()?.id === msg.id);
        if (peer) { try { peer.send(JSON.stringify(msg.d)); } catch (e) { /* noop */ } }
      }
      return;
    }
    // ゲスト → ホスト
    const host = this.findHost();
    if (host && message.length < 2000) host.send(`{"from":${me.id},"m":${message}}`);
  }

  async webSocketClose(ws) { this.leave(ws); }

  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    ws.serializeAttachment(null);
    const others = this.ctx.getWebSockets().filter((p) => p !== ws && p.deserializeAttachment());
    if (me.host) {
      for (const p of others) { try { p.send(JSON.stringify({ t: 'host_left' })); p.close(1000, 'host_left'); } catch (e) { /* noop */ } }
    } else {
      const host = others.find((p) => p.deserializeAttachment()?.host);
      if (host) this.sendHost(host, { t: 'peer_leave', id: me.id });
    }
  }
}
