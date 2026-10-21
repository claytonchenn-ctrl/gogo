// ═══════════════════════════════════════════════════════════
//  入口：菜单 → 建局 → 连接 Firebase → 开打
// ═══════════════════════════════════════════════════════════
import { Game } from './game.js';
import { FIREBASE_CONFIG, DEFAULT_ROOM } from './config.js';
import { LOADOUTS } from './weapons.js';
import { setInterp, INTERP_DEFAULT_RTC } from './net.js';
import { ManualHost, ManualGuest, dechunk } from './manual-signal.js';

const $ = id => document.getElementById(id);

const profile = {
  name: localStorage.getItem('fps.name') || '玩家' + Math.floor(Math.random() * 900 + 100),
  team: localStorage.getItem('fps.team') || 'red',
  loadout: +(localStorage.getItem('fps.loadout') || 0),
  sens: +(localStorage.getItem('fps.sens') || 1.0),
  room: localStorage.getItem('fps.room') || DEFAULT_ROOM,
  bots: +(localStorage.getItem('fps.bots') ?? 4),
  interp: +(localStorage.getItem('fps.interp') ?? INTERP_DEFAULT_RTC),
  netMode: localStorage.getItem('fps.netMode') || 'solo',
};

// ── 填充菜单 ──
$('inName').value = profile.name;
$('inRoom').value = profile.room;
$('inSens').value = profile.sens;
$('sensVal').textContent = profile.sens.toFixed(2);
$('inBots').value = profile.bots;
$('botsVal').textContent = profile.bots;
$('inInterp').value = profile.interp;
$('interpVal').textContent = profile.interp;

$('loadoutList').innerHTML = LOADOUTS.map((l, i) =>
  `<button class="lo ${i === profile.loadout ? 'sel' : ''}" data-i="${i}">
     <b>${l.name}</b><small>${l.primary.toUpperCase()} + ${l.secondary.toUpperCase()}</small>
     <small style="color:#6f7d8c">${l.d || ''}</small>
   </button>`).join('');
$('loadoutList').addEventListener('click', e => {
  const btn = e.target.closest('.lo');
  if (!btn) return;
  profile.loadout = +btn.dataset.i;
  [...$('loadoutList').children].forEach((c, i) =>
    c.classList.toggle('sel', i === profile.loadout));
});

for (const t of ['red', 'blue']) {
  $('team_' + t).addEventListener('click', () => {
    profile.team = t;
    $('team_red').classList.toggle('sel', t === 'red');
    $('team_blue').classList.toggle('sel', t === 'blue');
  });
}
$('team_' + profile.team).classList.add('sel');

$('inSens').addEventListener('input', e => {
  profile.sens = +e.target.value;
  $('sensVal').textContent = profile.sens.toFixed(2);
  if (window.__game) window.__game.mouse.sens = profile.sens;
});
$('inBots').addEventListener('input', e => {
  profile.bots = +e.target.value;
  $('botsVal').textContent = profile.bots;
});
$('inInterp').addEventListener('input', e => {
  profile.interp = +e.target.value;
  $('interpVal').textContent = profile.interp;
  setInterp(profile.interp);
});

// ── 开始游戏 ──
$('btnStart').addEventListener('click', async () => {
  profile.name = ($('inName').value || '玩家').slice(0, 12);
  profile.room = ($('inRoom').value || DEFAULT_ROOM).slice(0, 24);
  localStorage.setItem('fps.name', profile.name);
  localStorage.setItem('fps.team', profile.team);
  localStorage.setItem('fps.loadout', profile.loadout);
  localStorage.setItem('fps.sens', profile.sens);
  localStorage.setItem('fps.room', profile.room);
  localStorage.setItem('fps.bots', profile.bots);
  localStorage.setItem('fps.interp', profile.interp);
  setInterp(profile.interp);

  $('btnStart').disabled = true;
  $('btnStart').textContent = '连接中…';

  const game = new Game(profile);
  window.__game = game;
  gameRef = game;
  game.bindNet();

  let online = false;
  if (profile.netMode === 'fb') {
    online = await game.net.connect(FIREBASE_CONFIG, profile.room, profile);
  } else if (profile.netMode === 'code') {
    game.net.initManual(myUid, profile);
    const hostPeer = pendingPeers.find(p => !p.isHostSide);
    if (hostPeer) game.net._hostUid = hostPeer.uid;
    for (const p of pendingPeers) {
      game.net.attachManualPeer(p.uid, p.pc, p.dc, { name: p.name }, p.isHostSide);
    }
    online = pendingPeers.length > 0;
  }
  $('netBadge').textContent = online
    ? (profile.netMode === 'code'
        ? `已直连 ${pendingPeers.length} 人`
        : `已进入房间 ${profile.room} · 正在建立 P2P 直连…`)
    : '单机模式 · 只和机器人打';
  $('netBadge').className = online ? 'badge ok' : 'badge warn';
  game.net.on('peers', (n, ping) => {
    if (n > 0) console.log(`[net] P2P 直连 ${n} 人，平均延迟 ${ping}ms`);
  });

  // 机器人补位（两边各一半）
  const n = profile.bots;
  if (n > 0) {
    const enemy = profile.team === 'red' ? 'blue' : 'red';
    game.bots.spawn(Math.ceil(n / 2), enemy);
    if (n > 1) game.bots.spawn(Math.floor(n / 2), profile.team);
  }

  $('menu').style.display = 'none';
  $('hudRoot').style.display = 'block';
  game.start();
  game.requestPointer();
});

// 点击暂停遮罩重新锁定鼠标
$('pausedOverlay').addEventListener('click', () => window.__game?.requestPointer());

addEventListener('beforeunload', () => window.__game?.net.disconnect());


/* ═══════════════ 联机方式切换 ═══════════════ */
const myUid = 'u' + Math.random().toString(36).slice(2, 10);
let manualHost = null, manualGuest = null;
let pendingPeers = [];          // 开局前已连上的人，进游戏时接管
let gameRef = null;

function setMode(m) {
  profile.netMode = m;
  localStorage.setItem('fps.netMode', m);
  for (const k of ['solo', 'code', 'fb']) {
    $('mode_' + k).classList.toggle('sel', k === m);
  }
  $('roomField').style.display = m === 'fb' ? 'block' : 'none';
  $('codePanel').style.display = m === 'code' ? 'block' : 'none';
  $('btnStart').textContent = m === 'code' && pendingPeers.length === 0
    ? '先连上朋友，或直接单机开打' : '进 入 战 场';
}
for (const k of ['solo', 'code', 'fb']) {
  $('mode_' + k).addEventListener('click', () => setMode(k));
}
setMode(profile.netMode);

function setRole(r) {
  $('role_host').classList.toggle('sel', r === 'host');
  $('role_guest').classList.toggle('sel', r === 'guest');
  $('hostFlow').style.display = r === 'host' ? 'block' : 'none';
  $('guestFlow').style.display = r === 'guest' ? 'block' : 'none';
}
$('role_host').addEventListener('click', () => setRole('host'));
$('role_guest').addEventListener('click', () => setRole('guest'));

function renderPeers() {
  const el = $('peerList');
  if (!pendingPeers.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="hint ok" style="margin-bottom:6px">已连上 ' +
    pendingPeers.length + ' 人，可以开打了</div>' +
    pendingPeers.map(p => `<div class="peerRow"><b>${esc(p.name)}</b><span>已连接</span></div>`).join('');
  $('btnStart').textContent = '进 入 战 场';
}
const esc = t => String(t).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function copyText(text, btn, okLabel) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = okLabel || '已复制 ✓';
    setTimeout(() => { btn.textContent = old; }, 1600);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch {}
    document.body.removeChild(ta);
  }
}

/* ── 房主：生成邀请码 ── */
$('btnMakeInvite').addEventListener('click', async () => {
  const btn = $('btnMakeInvite');
  btn.disabled = true; btn.textContent = '正在生成…';
  $('inviteHint').className = 'hint wait';
  $('inviteHint').textContent = '正在收集网络地址…';
  try {
    profile.name = ($('inName').value || '房主').slice(0, 12);
    manualHost = manualHost || new ManualHost(myUid, profile.name);
    const { code } = await manualHost.createInvite(msg => {
      $('inviteHint').textContent = msg;
    });
    $('inviteCode').value = code;
    $('inviteOut').style.display = 'block';
    $('inviteHint').className = 'hint';
    $('inviteHint').textContent = `共 ${code.length} 个字符，微信一条消息发得完。发出去之后等他回一段码给你。`;
    btn.textContent = '再生成一个（邀请下一个人）';
  } catch (e) {
    $('inviteHint').className = 'hint err';
    $('inviteHint').textContent = '生成失败：' + e.message;
    btn.textContent = '重试';
  }
  btn.disabled = false;
});
$('btnCopyInvite').addEventListener('click', e =>
  copyText($('inviteCode').value, e.target, '已复制，去发微信 ✓'));

/* ── 房主：确认回执 ── */
$('btnAcceptAnswer').addEventListener('click', async () => {
  const btn = $('btnAcceptAnswer');
  const raw = dechunk($('answerIn').value);
  if (!raw) {
    $('answerHint').className = 'hint err';
    $('answerHint').textContent = '先把对方发回来的码粘进来';
    return;
  }
  btn.disabled = true; btn.textContent = '连接中…';
  $('answerHint').className = 'hint wait';
  $('answerHint').textContent = '正在建立直连…';
  try {
    const res = await manualHost.acceptAnswer(raw);
    const ok = await waitOpen(res.dc, 9000);
    if (!ok) throw new Error('通道没能打开。多半是双方网络都在严格 NAT 后面，换个网络试试（比如一方开手机热点）');
    pendingPeers.push({ uid: res.uid, name: res.name, pc: res.pc, dc: res.dc, isHostSide: true });
    renderPeers();
    $('answerHint').className = 'hint ok';
    $('answerHint').textContent = `已连上 ${res.name}！`;
    $('answerIn').value = '';
    if (gameRef) gameRef.net.attachManualPeer(res.uid, res.pc, res.dc, { name: res.name }, true);
  } catch (e) {
    $('answerHint').className = 'hint err';
    $('answerHint').textContent = e.message;
  }
  btn.disabled = false; btn.textContent = '确认连接';
});

/* ── 加入方：生成回执码 ── */
$('btnMakeAnswer').addEventListener('click', async () => {
  const btn = $('btnMakeAnswer');
  const raw = dechunk($('inviteIn').value);
  if (!raw) {
    $('guestHint').className = 'hint err';
    $('guestHint').textContent = '先把房主发给你的邀请码粘进来';
    return;
  }
  btn.disabled = true; btn.textContent = '正在生成…';
  $('guestHint').className = 'hint wait';
  $('guestHint').textContent = '正在收集网络地址…';
  try {
    profile.name = ($('inName').value || '玩家').slice(0, 12);
    manualGuest = new ManualGuest(myUid, profile.name);
    const res = await manualGuest.accept(raw, msg => { $('guestHint').textContent = msg; });
    $('answerCode').value = res.code;
    $('answerOut').style.display = 'block';
    $('guestHint').className = 'hint';
    $('guestHint').textContent = '把这段发回给房主，他粘贴后就连上了。';
    btn.textContent = '已生成';
    // 等房主那边确认，通道会自动打开
    res.chanReady.then(async dc => {
      const ok = await waitOpen(dc, 60000);
      if (!ok) return;
      pendingPeers.push({ uid: res.hostUid, name: res.hostName, pc: res.pc, dc, isHostSide: false });
      renderPeers();
      $('guestHint').className = 'hint ok';
      $('guestHint').textContent = `已连上房主 ${res.hostName}！可以进战场了。`;
      if (gameRef) {
        gameRef.net._hostUid = res.hostUid;
        gameRef.net.attachManualPeer(res.hostUid, res.pc, dc, { name: res.hostName }, false);
      }
    });
  } catch (e) {
    $('guestHint').className = 'hint err';
    $('guestHint').textContent = e.message;
    btn.textContent = '重试';
  }
  btn.disabled = false;
});
$('btnCopyAnswer').addEventListener('click', e =>
  copyText($('answerCode').value, e.target, '已复制，发回给房主 ✓'));

function waitOpen(dc, ms) {
  if (!dc) return Promise.resolve(false);
  if (dc.readyState === 'open') return Promise.resolve(true);
  return new Promise(res => {
    const t = setTimeout(() => res(false), ms);
    dc.addEventListener('open', () => { clearTimeout(t); res(true); }, { once: true });
  });
}
