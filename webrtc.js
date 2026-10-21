// ═══════════════════════════════════════════════════════════
//  WebRTC 点对点直连 —— 竞技延迟的关键
//
//  为什么不用 Firebase 传游戏数据：
//    你 → Google 机房 → 对手，往返 80~200ms，而且频率只有 10~20Hz。
//    就算把插值缓冲调成 0，延迟一点没少，画面还会变成卡顿瞬移。
//
//  WebRTC 的做法：
//    Firebase 只用来「牵线」——交换一次连接信息（offer/answer/ICE）。
//    线搭上以后，游戏数据走 你 ↔ 对手 的直连通道，不经过任何服务器。
//    延迟 = 你俩之间的真实 ping。同城 5~20ms，同国 20~50ms。
//
//  通道配置成「不可靠不排序」（等价于 UDP）：
//    丢一个位置包无所谓，下一个 16ms 后就到了。
//    绝不能排队重传 —— 那会造成卡顿式的延迟堆积。
// ═══════════════════════════════════════════════════════════

export const SEND_HZ_RTC = 60;        // P2P 下可以跑满 60Hz

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export class PeerMesh {
  constructor(uid, fb, db, basePath) {
    this.uid = uid;
    this.fb = fb;
    this.db = db;
    this.base = basePath;
    this.peers = new Map();          // uid -> { pc, dc, state, ping, lastPong }
    this.onData = () => {};
    this.onPeerState = () => {};
    this._signalUnsub = null;
  }

  // 谁主动发起：UID 字典序小的一方，保证不会双方同时 offer
  _isInitiator(otherUid) { return this.uid < otherUid; }

  async connectTo(otherUid, meta) {
    if (this.peers.has(otherUid)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 });
    const rec = { pc, dc: null, state: 'connecting', ping: 0, meta,
                  lastPong: performance.now(), pingTimer: null };
    this.peers.set(otherUid, rec);

    pc.onicecandidate = e => {
      if (e.candidate) this._signal(otherUid, { kind: 'ice', data: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this._drop(otherUid, pc.connectionState);
      }
    };
    pc.ondatachannel = e => this._bindChannel(otherUid, e.channel);

    if (this._isInitiator(otherUid)) {
      // 关键配置：不可靠 + 不排序 = UDP 行为，绝不堆积延迟
      const dc = pc.createDataChannel('game', {
        ordered: false,
        maxRetransmits: 0,
      });
      this._bindChannel(otherUid, dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._signal(otherUid, { kind: 'offer', data: { type: offer.type, sdp: offer.sdp } });
    }
  }

  _bindChannel(otherUid, dc) {
    const rec = this.peers.get(otherUid);
    if (!rec) return;
    rec.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      rec.state = 'open';
      this.onPeerState(otherUid, 'open', rec);
      // 心跳测延迟
      rec.pingTimer = setInterval(() => {
        if (dc.readyState !== 'open') return;
        try { dc.send(JSON.stringify({ t: 'ping', s: performance.now() })); } catch {}
      }, 1000);
    };
    dc.onclose = () => this._drop(otherUid, 'closed');
    dc.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'ping') {
        try { dc.send(JSON.stringify({ t: 'pong', s: m.s })); } catch {}
        return;
      }
      if (m.t === 'pong') {
        rec.ping = Math.round(performance.now() - m.s);
        rec.lastPong = performance.now();
        return;
      }
      this.onData(otherUid, m);
    };
  }

  // 收到对方的信令
  async handleSignal(fromUid, sig, meta) {
    let rec = this.peers.get(fromUid);
    if (!rec) { await this.connectTo(fromUid, meta); rec = this.peers.get(fromUid); }
    if (!rec) return;
    const pc = rec.pc;
    try {
      if (sig.kind === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sig.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._signal(fromUid, { kind: 'answer', data: { type: answer.type, sdp: answer.sdp } });
        // 把排队的 ICE 补上
        for (const c of (rec.pendingIce || [])) await pc.addIceCandidate(c).catch(() => {});
        rec.pendingIce = [];
      } else if (sig.kind === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(sig.data));
          for (const c of (rec.pendingIce || [])) await pc.addIceCandidate(c).catch(() => {});
          rec.pendingIce = [];
        }
      } else if (sig.kind === 'ice') {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(sig.data).catch(() => {});
        } else {
          (rec.pendingIce = rec.pendingIce || []).push(sig.data);
        }
      }
    } catch (err) {
      console.warn('[rtc] 信令处理失败', fromUid, err.message);
    }
  }

  _signal(toUid, payload) {
    const r = this.fb.ref(this.db, `${this.base}/signals/${toUid}/${this.uid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    this.fb.set(r, { ...payload, from: this.uid, ts: Date.now() })
      .then(() => setTimeout(() => this.fb.remove(r).catch(() => {}), 20000))
      .catch(() => {});
  }

  // 广播给所有已连接的人（不可靠通道，发完就忘）
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const [, rec] of this.peers) {
      if (rec.dc && rec.dc.readyState === 'open') {
        try { rec.dc.send(s); } catch {}
      }
    }
  }

  sendTo(uid, obj) {
    const rec = this.peers.get(uid);
    if (rec && rec.dc && rec.dc.readyState === 'open') {
      try { rec.dc.send(JSON.stringify(obj)); } catch {}
    }
  }

  avgPing() {
    const v = [...this.peers.values()].filter(r => r.state === 'open').map(r => r.ping);
    if (!v.length) return 0;
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  }
  openCount() {
    return [...this.peers.values()].filter(r => r.state === 'open').length;
  }

  _drop(uid, why) {
    const rec = this.peers.get(uid);
    if (!rec) return;
    if (rec.pingTimer) clearInterval(rec.pingTimer);
    try { rec.pc.close(); } catch {}
    this.peers.delete(uid);
    this.onPeerState(uid, 'closed', rec, why);
  }

  closeAll() {
    for (const uid of [...this.peers.keys()]) this._drop(uid, 'bye');
  }
}
