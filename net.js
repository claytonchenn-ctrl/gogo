// ═══════════════════════════════════════════════════════════
//  网络层 —— Firebase Realtime Database
//
//  核心问题：Firebase 实际同步频率只有 10~20Hz，延迟 80~200ms，
//  而 FPS 需要 60Hz 的画面。直接把收到的位置贴上去会像幻灯片。
//
//  解法（所有网游的标准做法）：
//    · 自己：本地 60fps 立即响应，不等服务器（客户端预测）
//    · 别人：缓存最近几个快照，故意延迟 INTERP_MS 渲染，
//           在两个快照之间做线性插值 → 画面丝滑
//    · 打中判定：打你屏幕上看到的位置，由被打的人自己扣血
// ═══════════════════════════════════════════════════════════

import { PeerMesh, SEND_HZ_RTC } from './webrtc.js';

export const SEND_HZ = 15;          // Firebase 回退模式的上报频率
// 插值缓冲：P2P 下包间隔只有 16ms，缓冲可以压到几乎无感
// 可在菜单里调；设成 0 就是完全不做延迟处理（会看到轻微抖动，但零额外延迟）
export const INTERP_DEFAULT_RTC = 35;
export const INTERP_DEFAULT_FB = 110;
export let INTERP_MS = INTERP_DEFAULT_RTC;
let _userInterp = INTERP_DEFAULT_RTC;   // 玩家在菜单里设的值（针对 P2P）
let _mode = 'firebase';

// 缓冲必须覆盖一个收包间隔，否则会频繁外推造成跳变：
//   P2P 60Hz → 包间隔 16ms，35ms 绰绰有余
//   Firebase 15Hz → 包间隔 67ms，低于 90ms 就会抖
// 所以退回中转模式时自动抬高，不让画面崩掉。
export function setInterp(ms) {
  _userInterp = Math.max(0, ms | 0);
  applyInterp();
}
export function setNetMode(mode) { _mode = mode; applyInterp(); }
function applyInterp() {
  INTERP_MS = _mode === 'p2p' ? _userInterp : Math.max(_userInterp, INTERP_DEFAULT_FB);
}
const SNAPSHOT_KEEP = 20;           // 每个远端玩家保留多少历史快照

export class Net {
  constructor() {
    this.ready = false;
    this.offline = true;
    this.uid = null;
    this.room = null;
    this.players = new Map();        // uid -> { snaps:[], meta:{} }
    this.listeners = { hit: [], shot: [], kill: [], chat: [], join: [], leave: [], throw: [], peers: [] };
    this._lastSend = 0;
    this._db = null;
    this._fb = null;
    this._refs = {};
    this.latency = 0;
    this._serverOffset = 0;
    this.mesh = null;            // WebRTC 网格
    this.mode = 'offline';       // offline | firebase | p2p
    this._rtcLastSend = 0;
  }

  get ping() { return this.manual ? this.manualPing() : (this.mesh ? this.mesh.avgPing() : 0); }
  get peerCount() { return this.manual ? (this.manualPeers?.size || 0) : (this.mesh ? this.mesh.openCount() : 0); }

  on(evt, fn) { this.listeners[evt]?.push(fn); return this; }
  _emit(evt, ...a) { this.listeners[evt]?.forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); }

  // 服务器时间（用于跨客户端对齐插值时间轴）
  now() { return Date.now() + this._serverOffset; }

  // ── 连接 ──────────────────────────────────────────────
  async connect(config, roomId, profile) {
    if (!config || !config.databaseURL || config.apiKey === 'PASTE_YOUR_API_KEY') {
      console.warn('[net] 未配置 Firebase，进入离线模式（只能打机器人）');
      this.offline = true;
      return false;
    }
    try {
      const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const dbMod  = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js');
      const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      this._fb = { ...dbMod };

      const app = appMod.initializeApp(config);
      const auth = authMod.getAuth(app);
      const cred = await authMod.signInAnonymously(auth);
      this.uid = cred.user.uid;
      this._db = dbMod.getDatabase(app);

      // 校准服务器时间偏移
      const offSnap = await dbMod.get(dbMod.ref(this._db, '.info/serverTimeOffset'));
      this._serverOffset = offSnap.val() || 0;

      this.room = roomId;
      this.profileName = profile.name;
      this.profileTeam = profile.team;
      this.profileLoadout = profile.loadout;
      const base = `rooms/${roomId}`;
      const { ref, onValue, onChildAdded, onChildRemoved, onChildChanged,
              onDisconnect, set, update, push, remove, serverTimestamp } = dbMod;

      this._refs.me = ref(this._db, `${base}/players/${this.uid}`);
      this._refs.players = ref(this._db, `${base}/players`);
      this._refs.events = ref(this._db, `${base}/events`);

      // 断线自动清理
      onDisconnect(this._refs.me).remove();

      // 写入初始状态
      await set(this._refs.me, {
        n: profile.name, t: profile.team, lo: profile.loadout,
        p: [0, 0, 0], r: [0, 0], h: 100, sh: 0, w: 0, f: 0,
        k: 0, d: 0, ts: serverTimestamp(),
      });

      // 监听其他玩家
      onChildAdded(this._refs.players, snap => {
        if (snap.key === this.uid) return;
        this._ingest(snap.key, snap.val(), true);
        this._emit('join', snap.key, snap.val());
      });
      onChildChanged(this._refs.players, snap => {
        if (snap.key === this.uid) return;
        this._ingest(snap.key, snap.val(), false);
      });
      onChildRemoved(this._refs.players, snap => {
        this.players.delete(snap.key);
        this._emit('leave', snap.key);
      });

      // 监听事件流（开枪特效 / 命中 / 击杀播报 / 聊天）
      onChildAdded(this._refs.events, snap => {
        const e = snap.val();
        if (!e) return;
        // 清掉太旧的事件，避免数据库无限膨胀
        if (this.now() - (e.ts || 0) > 8000) { remove(snap.ref); return; }
        if (e.type === 'shot' && e.by !== this.uid) this._emit('shot', e);
        if (e.type === 'throw' && e.by !== this.uid) this._emit('throw', e);
        if (e.type === 'hit' && e.to === this.uid) this._emit('hit', e);
        if (e.type === 'kill') this._emit('kill', e);
        if (e.type === 'chat') this._emit('chat', e);
      });

      // ── WebRTC：游戏数据走点对点，Firebase 只负责牵线 ──
      this.mesh = new PeerMesh(this.uid, dbMod, this._db, base);
      this.mesh.onData = (fromUid, m) => this._onPeerData(fromUid, m);
      this.mesh.onPeerState = (uid, st) => {
        this.mode = this.mesh.openCount() > 0 ? 'p2p' : 'firebase';
        setNetMode(this.mode);          // 缓冲跟着传输模式走
        this._emit('peers', this.mesh.openCount(), this.mesh.avgPing());
      };

      // 发现房间里已有的人并发起连接
      onChildAdded(this._refs.players, snap => {
        if (snap.key === this.uid) return;
        this.mesh.connectTo(snap.key, snap.val()).catch(() => {});
      });

      // 监听发给我的信令
      this._refs.signals = ref(this._db, `${base}/signals/${this.uid}`);
      onChildAdded(this._refs.signals, snap => {
        const sig = snap.val();
        remove(snap.ref).catch(() => {});
        if (!sig || !sig.from || sig.from === this.uid) return;
        this.mesh.handleSignal(sig.from, sig, null).catch(() => {});
      });
      onDisconnect(this._refs.signals).remove();

      this.ready = true;
      this.offline = false;
      this.mode = 'firebase';
      setNetMode('firebase');
      console.log('[net] 已连接房间', roomId, '身份', this.uid, '— 正在建立 P2P 直连…');
      return true;
    } catch (err) {
      console.error('[net] 连接失败，退回离线模式：', err.message);
      this.offline = true;
      return false;
    }
  }

  // ══════════ 手动连接码模式（无 Firebase，中国可用）══════════
  // 把已经握手成功的连接接管过来，并开启「自动牵线」：
  // 新人只和房主手动交换一次码，房主帮他和房里其他人自动连上。
  initManual(uid, profile) {
    this.uid = uid;
    this.offline = false;
    this.ready = true;
    this.mode = 'p2p';
    this.manual = true;
    this.profileName = profile.name;
    this.profileTeam = profile.team;
    this.profileLoadout = profile.loadout;
    this.manualPeers = new Map();     // uid -> { pc, dc, name }
    this._pendingRelay = new Map();   // uid -> RTCPeerConnection（中转建立中的）
    setNetMode('p2p');
  }

  attachManualPeer(uid, pc, dc, meta, isHost) {
    if (!this.manualPeers) this.manualPeers = new Map();
    const rec = { pc, dc, name: meta?.name || '玩家', ping: 0, isHost };
    this.manualPeers.set(uid, rec);

    dc.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'ping') { try { dc.send(JSON.stringify({ t: 'pong', s: m.s })); } catch {} return; }
      if (m.t === 'pong') { rec.ping = Math.round(performance.now() - m.s); return; }
      if (m.t === 'peers') return this._onPeerList(uid, m.list);
      if (m.t === 'relay') return this._relaySignal(uid, m);
      if (m.t === 'relayed') return this._onRelayedSignal(m);
      this._onPeerData(uid, m);
    };
    dc.onclose = () => {
      this.manualPeers.delete(uid);
      this.players.delete(uid);
      this._emit('leave', uid);
      this._emit('peers', this.manualPeers.size, this.manualPing());
    };
    rec.pingTimer = setInterval(() => {
      if (dc.readyState !== 'open') return;
      try { dc.send(JSON.stringify({ t: 'ping', s: performance.now() })); } catch {}
    }, 1000);

    // 房主：把房间现有成员告诉新人，并通知老成员有新人来了
    if (isHost) {
      const list = [...this.manualPeers.entries()]
        .filter(([u]) => u !== uid)
        .map(([u, r]) => ({ uid: u, name: r.name }));
      if (list.length) { try { dc.send(JSON.stringify({ t: 'peers', list })); } catch {} }
    }
    this._emit('peers', this.manualPeers.size, this.manualPing());
  }

  // 收到房主发来的成员名单 → 主动和他们建立直连（信令由房主转发）
  async _onPeerList(hostUid, list) {
    for (const p of list) {
      if (p.uid === this.uid || this.manualPeers.has(p.uid)) continue;
      // UID 小的一方发起，避免双方同时 offer
      if (this.uid > p.uid) continue;
      await this._startRelayOffer(hostUid, p.uid, p.name);
    }
  }

  async _startRelayOffer(viaUid, toUid, toName) {
    const { ICE_SERVERS_CN } = await import('./manual-signal.js');
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS_CN });
    const dc = pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
    this._pendingRelay.set(toUid, { pc, dc, name: toName });
    dc.onopen = () => {
      this._pendingRelay.delete(toUid);
      this.attachManualPeer(toUid, pc, dc, { name: toName }, false);
    };
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      this._sendRelay(viaUid, toUid, { kind: 'ice', data: e.candidate.toJSON() });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._sendRelay(viaUid, toUid, { kind: 'offer', data: { type: 'offer', sdp: offer.sdp },
                                     name: this.profileName });
  }

  _sendRelay(viaUid, toUid, sig) {
    const via = this.manualPeers.get(viaUid);
    if (!via || via.dc.readyState !== 'open') return;
    try { via.dc.send(JSON.stringify({ t: 'relay', to: toUid, from: this.uid, sig })); } catch {}
  }

  // 房主收到转发请求 → 投递给目标
  _relaySignal(fromUid, m) {
    const target = this.manualPeers.get(m.to);
    if (!target || target.dc.readyState !== 'open') return;
    try { target.dc.send(JSON.stringify({ t: 'relayed', from: m.from, sig: m.sig })); } catch {}
  }

  // 收到经房主转发的信令
  async _onRelayedSignal(m) {
    const from = m.from, sig = m.sig;
    let rec = this._pendingRelay.get(from);
    if (!rec && sig.kind === 'offer') {
      const { ICE_SERVERS_CN } = await import('./manual-signal.js');
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS_CN });
      rec = { pc, dc: null, name: sig.name || '玩家', host: this._hostUid };
      this._pendingRelay.set(from, rec);
      pc.ondatachannel = e => {
        this._pendingRelay.delete(from);
        this.attachManualPeer(from, pc, e.channel, { name: rec.name }, false);
      };
      pc.onicecandidate = e => {
        if (!e.candidate) return;
        this._sendRelay(this._hostUid, from, { kind: 'ice', data: e.candidate.toJSON() });
      };
    }
    if (!rec) return;
    const pc = rec.pc;
    try {
      if (sig.kind === 'offer') {
        await pc.setRemoteDescription(sig.data);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        this._sendRelay(this._hostUid, from, { kind: 'answer', data: { type: 'answer', sdp: ans.sdp } });
        for (const c of (rec.q || [])) await pc.addIceCandidate(c).catch(() => {});
        rec.q = [];
      } else if (sig.kind === 'answer') {
        if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(sig.data);
        for (const c of (rec.q || [])) await pc.addIceCandidate(c).catch(() => {});
        rec.q = [];
      } else if (sig.kind === 'ice') {
        if (pc.remoteDescription?.type) await pc.addIceCandidate(sig.data).catch(() => {});
        else (rec.q = rec.q || []).push(sig.data);
      }
    } catch (err) { console.warn('[manual] 中转信令失败', err.message); }
  }

  manualPing() {
    if (!this.manualPeers?.size) return 0;
    const v = [...this.manualPeers.values()].map(r => r.ping);
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  }

  manualBroadcast(obj) {
    if (!this.manualPeers) return;
    const s = JSON.stringify(obj);
    for (const [, r] of this.manualPeers) {
      if (r.dc?.readyState === 'open') { try { r.dc.send(s); } catch {} }
    }
  }

  // ── P2P 收包：位置走高频通道，事件也走同一条 ──
  _onPeerData(fromUid, m) {
    if (m.t === 's') {               // state 位置快照
      this._ingest(fromUid, {
        n: m.n, t: m.tm, lo: m.lo, p: m.p, r: m.r,
        h: m.h, sh: m.sh, w: m.w, f: m.f, k: m.k, d: m.d,
        ts: this.now(),              // P2P 延迟极低，用本地时间轴足够准
      }, false);
      return;
    }
    if (m.t === 'hit' && m.to === this.uid) this._emit('hit', { ...m, by: fromUid });
    else if (m.t === 'kill') this._emit('kill', { ...m });
    else if (m.t === 'shot') this._emit('shot', { ...m, by: fromUid });
    else if (m.t === 'throw') this._emit('throw', { ...m, by: fromUid });
    else if (m.t === 'chat') this._emit('chat', { ...m, by: fromUid });
  }

  // ── 接收远端快照并排入插值缓冲 ──────────────────────
  _ingest(uid, val, isNew) {
    if (!val) return;
    let rec = this.players.get(uid);
    if (!rec) {
      rec = { snaps: [], meta: {} };
      this.players.set(uid, rec);
    }
    rec.meta = { name: val.n, team: val.t, loadout: val.lo, kills: val.k || 0,
                 deaths: val.d || 0, health: val.h, shield: val.sh || 0,
                 weapon: val.w, flags: val.f || 0 };
    rec.snaps.push({
      t: typeof val.ts === 'number' ? val.ts : this.now(),
      p: val.p || [0, 0, 0],
      r: val.r || [0, 0],
      f: val.f || 0,
    });
    if (rec.snaps.length > SNAPSHOT_KEEP) rec.snaps.shift();
  }

  // ── 上传自己的状态（限频）────────────────────────────
  sendState(st) {
    if (this.offline || !this.ready) return;
    const now = performance.now();

    // ① 手动模式：直接走已建立的通道
    if (this.manual) {
      if (now - this._rtcLastSend >= 1000 / SEND_HZ_RTC) {
        this._rtcLastSend = now;
        this.manualBroadcast({
          t: 's', n: this.profileName, tm: this.profileTeam, lo: this.profileLoadout,
          p: [+st.pos.x.toFixed(2), +st.pos.y.toFixed(2), +st.pos.z.toFixed(2)],
          r: [+st.yaw.toFixed(3), +st.pitch.toFixed(3)],
          h: st.health, sh: st.shield, w: st.weaponIdx, f: st.flags,
          k: st.kills, d: st.deaths,
        });
      }
      return;
    }

    // ② P2P 通道：60Hz 高频直发，这是低延迟的来源
    if (this.mesh && this.mesh.openCount() > 0) {
      if (now - this._rtcLastSend >= 1000 / SEND_HZ_RTC) {
        this._rtcLastSend = now;
        this.mesh.broadcast({
          t: 's', n: this.profileName, tm: this.profileTeam, lo: this.profileLoadout,
          p: [+st.pos.x.toFixed(2), +st.pos.y.toFixed(2), +st.pos.z.toFixed(2)],
          r: [+st.yaw.toFixed(3), +st.pitch.toFixed(3)],
          h: st.health, sh: st.shield, w: st.weaponIdx, f: st.flags,
          k: st.kills, d: st.deaths,
        });
      }
    }

    // ② Firebase 低频兜底：维持房间在线列表 + 给还没连上 P2P 的人看
    if (now - this._lastSend < 1000 / SEND_HZ) return;
    this._lastSend = now;
    this._fb.update(this._refs.me, {
      p: [+st.pos.x.toFixed(2), +st.pos.y.toFixed(2), +st.pos.z.toFixed(2)],
      r: [+st.yaw.toFixed(3), +st.pitch.toFixed(3)],
      h: st.health, sh: st.shield, w: st.weaponIdx, f: st.flags,
      k: st.kills, d: st.deaths,
      ts: this._fb.serverTimestamp(),
    }).catch(() => {});
  }

  _pushEvent(obj) {
    if (this.offline || !this.ready) return;
    if (this.manual) {
      const short = { ...obj, t: obj.type };
      delete short.type;
      if (obj.to) {
        const r = this.manualPeers?.get(obj.to);
        if (r?.dc?.readyState === 'open') { try { r.dc.send(JSON.stringify(short)); } catch {} }
      } else this.manualBroadcast(short);
      return;
    }
    // P2P 可达时事件也走直连（延迟从 150ms 降到 20ms）
    if (this.mesh && this.mesh.openCount() > 0) {
      const short = { ...obj, t: obj.type };
      delete short.type;
      if (obj.to) this.mesh.sendTo(obj.to, short); else this.mesh.broadcast(short);
      if (obj.type === 'hit' || obj.type === 'kill') return;   // 这两个不必再过 Firebase
    }
    const r = this._fb.push(this._refs.events);
    this._fb.set(r, { ...obj, ts: this._fb.serverTimestamp() }).catch(() => {});
    // 6 秒后自己清掉，保持数据库干净
    setTimeout(() => this._fb.remove(r).catch(() => {}), 6000);
  }

  sendShot(origin, dir, weaponKey) {
    this._pushEvent({ type: 'shot', by: this.uid,
      o: [+origin.x.toFixed(2), +origin.y.toFixed(2), +origin.z.toFixed(2)],
      d: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)], w: weaponKey });
  }
  sendHit(targetUid, dmg, part, weaponKey) {
    this._pushEvent({ type: 'hit', by: this.uid, to: targetUid, dmg, part, w: weaponKey });
  }
  // 注意：这个事件由【被击杀的人】发出，因为只有他本机知道自己血量归零了。
  // 所以 by = 凶手，to = 死者（我自己）。接收端判断 e.by === 自己 才算拿到人头。
  sendDeath(killerUid, weaponKey, part) {
    this._pushEvent({ type: 'kill', by: killerUid, to: this.uid, w: weaponKey, part });
  }
  sendThrow(origin, dir, weaponKey) {
    this._pushEvent({ type: 'throw', by: this.uid,
      o: [+origin.x.toFixed(2), +origin.y.toFixed(2), +origin.z.toFixed(2)],
      d: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)], w: weaponKey });
  }
  sendChat(text) {
    this._pushEvent({ type: 'chat', by: this.uid, msg: String(text).slice(0, 120) });
  }

  // ── 取某个远端玩家在"插值时刻"的平滑状态 ─────────────
  // 这是让画面不卡顿的关键：渲染的是 110ms 之前的世界
  interpolate(uid) {
    const rec = this.players.get(uid);
    if (!rec || rec.snaps.length === 0) return null;
    const snaps = rec.snaps;
    const target = this.now() - INTERP_MS;

    // 只有一个快照 / 目标时刻早于最旧快照 → 直接用最旧的
    if (snaps.length === 1 || target <= snaps[0].t) {
      const s = snaps[snaps.length === 1 ? 0 : 0];
      return { pos: s.p, rot: s.r, flags: s.f, meta: rec.meta, extrapolated: false };
    }
    // 目标时刻超过最新快照 → 外推（对方卡了，维持最后状态）
    const last = snaps[snaps.length - 1];
    if (target >= last.t) {
      return { pos: last.p, rot: last.r, flags: last.f, meta: rec.meta, extrapolated: true };
    }
    // 正常情况：找到夹住 target 的两个快照做线性插值
    for (let i = snaps.length - 1; i > 0; i--) {
      const b = snaps[i], a = snaps[i - 1];
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        const k = span > 0 ? (target - a.t) / span : 0;
        return {
          pos: [a.p[0] + (b.p[0] - a.p[0]) * k,
                a.p[1] + (b.p[1] - a.p[1]) * k,
                a.p[2] + (b.p[2] - a.p[2]) * k],
          rot: [lerpAngle(a.r[0], b.r[0], k), a.r[1] + (b.r[1] - a.r[1]) * k],
          flags: b.f, meta: rec.meta, extrapolated: false,
        };
      }
    }
    return { pos: last.p, rot: last.r, flags: last.f, meta: rec.meta, extrapolated: true };
  }

  disconnect() {
    if (this.manualPeers) {
      for (const [, r] of this.manualPeers) {
        if (r.pingTimer) clearInterval(r.pingTimer);
        try { r.pc.close(); } catch {}
      }
      this.manualPeers.clear();
    }
    if (this.mesh) this.mesh.closeAll();
    if (!this.offline && this._refs.me) this._fb.remove(this._refs.me).catch(() => {});
  }
}

// 角度插值：处理 -π / +π 的环绕
export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// 状态位标记
export const FLAG = { CROUCH: 1, MOVE: 2, DEAD: 4, FIRE: 8, SCOPE: 16 };
