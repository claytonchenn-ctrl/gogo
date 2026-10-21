// ═══════════════════════════════════════════════════════════
//  手动连接码 —— 不需要任何服务器的联机方式
//
//  为什么要这个：Firebase 在中国大陆连不上（Google 域名被墙）。
//  但 WebRTC 的点对点部分本身是通的，坏掉的只是「牵线」这一步。
//  于是把牵线改成人工：A 生成一段码发微信给 B，B 回一段码，连上。
//
//  关键技术点：
//   ① Vanilla ICE —— 等所有候选地址收集完再导出 SDP，
//      这样只需交换一次，不用持续来回传 ICE。
//   ② deflate 压缩 + base64 —— 原始 SDP 有 2~4KB，微信里发着难受，
//      压完通常 600~900 字符，能一条消息发出去。
//   ③ 只有第一个人要手动交换；连上之后由已在房间里的人
//      自动帮新人和其他人牵线，4 个人只需 3 次复制粘贴。
// ═══════════════════════════════════════════════════════════

// 中国大陆可访问的 STUN（Google 的 stun.l.google.com 在国内被墙）
export const ICE_SERVERS_CN = [
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },     // 国外玩家用得上
];

// ── 压缩 / 解压 ───────────────────────────────────────
function u8ToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64ToU8(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export async function pack(obj) {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream === 'undefined') {
    return 'R' + u8ToB64(new TextEncoder().encode(json));   // 老浏览器：不压缩
  }
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return 'Z' + u8ToB64(new Uint8Array(buf));
}

export async function unpack(code) {
  const clean = String(code).trim().replace(/\s+/g, '');
  if (!clean) throw new Error('连接码是空的');
  const tag = clean[0], body = clean.slice(1);
  if (tag === 'R') return JSON.parse(new TextDecoder().decode(b64ToU8(body)));
  if (tag !== 'Z') throw new Error('连接码格式不对，确认复制完整了吗');
  const stream = new Blob([b64ToU8(body)]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(buf));
}

// ── SDP 瘦身：去掉对连接没用的行，压缩后能再小一截 ──
function slimSdp(sdp) {
  return sdp.split('\r\n').filter(l => {
    if (l.startsWith('a=extmap')) return false;
    if (l.startsWith('a=rtcp-fb')) return false;
    if (l.startsWith('a=ssrc')) return false;
    if (l.startsWith('a=msid')) return false;
    return true;
  }).join('\r\n');
}

// ── 等 ICE 收集完（Vanilla ICE）────────────────────────
function waitIce(pc, onProgress, timeoutMs = 4000) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let done = false, gotHost = false, gotSrflx = false;
    const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
    const onChange = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const onCand = e => {
      if (!e.candidate) return finish();
      const c = e.candidate.candidate;
      if (c.includes('typ host') && !gotHost) { gotHost = true; onProgress?.('已找到本机地址…'); }
      if (c.includes('typ srflx') && !gotSrflx) {
        gotSrflx = true;
        onProgress?.('已拿到公网地址，正在收尾…');
        setTimeout(finish, 600);       // 公网地址到手，再等一下别的候选就够了
      }
      if (c.includes('typ relay')) onProgress?.('已连上中继服务器…');
    };
    const cleanup = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      pc.removeEventListener('icecandidate', onCand);
      clearTimeout(t1); clearTimeout(t2);
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    pc.addEventListener('icecandidate', onCand);
    // 2.2 秒还没拿到公网地址：多半是 STUN 不通，有本机地址就先用（局域网能玩）
    const t1 = setTimeout(() => {
      if (!gotSrflx && gotHost) { onProgress?.('没拿到公网地址，只能局域网联机'); finish(); }
    }, 2200);
    const t2 = setTimeout(finish, timeoutMs);
  });
}

// ═══════════════════════════════════════════════════════════
//  房主侧：生成邀请码 → 等对方回执码 → 连上
// ═══════════════════════════════════════════════════════════
export class ManualHost {
  constructor(myUid, myName, onChannel) {
    this.uid = myUid;
    this.name = myName;
    this.onChannel = onChannel;
    this.pending = new Map();      // inviteId -> { pc, dc }
  }

  // 生成一段邀请码，发给朋友
  async createInvite(onProgress) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS_CN, iceCandidatePoolSize: 2 });
    const dc = pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
    const id = Math.random().toString(36).slice(2, 9);
    this.pending.set(id, { pc, dc });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc, onProgress);

    const code = await pack({
      v: 1, k: 'offer', id, uid: this.uid, n: this.name,
      sdp: slimSdp(pc.localDescription.sdp),
    });
    return { code, id, pc, dc };
  }

  // 粘贴对方回执码，完成连接
  async acceptAnswer(code) {
    const data = await unpack(code);
    if (data.k !== 'answer') throw new Error('这不是回执码，应该粘贴对方发回来的那一段');
    const rec = this.pending.get(data.id);
    if (!rec) throw new Error('找不到对应的邀请，可能已经过期，重新生成一次');
    await rec.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    this.pending.delete(data.id);
    return { pc: rec.pc, dc: rec.dc, uid: data.uid, name: data.n };
  }
}

// ═══════════════════════════════════════════════════════════
//  加入方：粘贴邀请码 → 生成回执码
// ═══════════════════════════════════════════════════════════
export class ManualGuest {
  constructor(myUid, myName) {
    this.uid = myUid;
    this.name = myName;
  }

  async accept(inviteCode, onProgress) {
    const data = await unpack(inviteCode);
    if (data.k !== 'offer') throw new Error('这不是邀请码，应该粘贴房主发给你的那一段');

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS_CN, iceCandidatePoolSize: 2 });
    let dc = null;
    const chanReady = new Promise(res => { pc.ondatachannel = e => { dc = e.channel; res(e.channel); }; });

    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc, onProgress);

    const code = await pack({
      v: 1, k: 'answer', id: data.id, uid: this.uid, n: this.name,
      sdp: slimSdp(pc.localDescription.sdp),
    });
    return { code, pc, chanReady, hostUid: data.uid, hostName: data.n };
  }
}

// ── 把码切成几段，方便在聊天软件里发 ──
export function chunk(code, size = 900) {
  if (code.length <= size) return [code];
  const parts = [];
  for (let i = 0; i < code.length; i += size) parts.push(code.slice(i, i + size));
  return parts.map((p, i) => `[${i + 1}/${parts.length}]${p}`);
}
export function dechunk(text) {
  const t = String(text).trim();
  if (!t.includes('[')) return t.replace(/\s+/g, '');
  const parts = [...t.matchAll(/\[(\d+)\/(\d+)\]([A-Za-z0-9\-_]+)/g)]
    .sort((a, b) => +a[1] - +b[1]).map(m => m[3]);
  return parts.join('');
}
