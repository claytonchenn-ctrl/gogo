// ═══════════════════════════════════════════════════════════
//  HUD —— 准星 / 血量 / 弹药 / 小地图 / 击杀播报 / 记分板
// ═══════════════════════════════════════════════════════════
import { MAP } from './map.js';
import { WEAPONS, computeSpread } from './weapons.js';

const $ = id => document.getElementById(id);

export class HUD {
  constructor(game) {
    this.g = game;
    this.killfeed = [];
    this.chatLog = [];
    this.chatOpen = false;
    this.hitMarker = 0;
    this.hitMarkerHead = false;
    this.damageFlash = 0;
    this.killBanner = 0;
    this.el = {
      hp: $('hp'), shield: $('shield'), hpBar: $('hpBar'), shBar: $('shBar'),
      ammo: $('ammo'), reserve: $('reserve'), wname: $('wname'),
      crosshair: $('crosshair'), kf: $('killfeed'), chat: $('chatlog'),
      chatInput: $('chatInput'), scoreboard: $('scoreboard'), sbBody: $('sbBody'),
      dead: $('deadOverlay'), deadTimer: $('deadTimer'), killer: $('killerName'),
      paused: $('pausedOverlay'), hitFlash: $('hitFlash'), killMsg: $('killMsg'),
      scopeOverlay: $('scopeOverlay'), netInfo: $('netInfo'), reloadBar: $('reloadBar'),
    };
    this.mini = $('minimap');
    this.mctx = this.mini.getContext('2d');
    this.resize();
    this.setupChat();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    this.mini.width = 180 * dpr;
    this.mini.height = 180 * dpr;
    this.mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setupChat() {
    this.el.chatInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.code === 'Enter') {
        const v = this.el.chatInput.value.trim();
        if (v) { this.g.net.sendChat(v); this.pushChat('你', v); }
        this.closeChat();
      } else if (e.code === 'Escape') this.closeChat();
    });
  }
  openChat() {
    this.chatOpen = true;
    this.el.chatInput.parentElement.style.display = 'block';
    this.el.chatInput.value = '';
    this.el.chatInput.focus();
    this.g.releasePointer();
  }
  closeChat() {
    this.chatOpen = false;
    this.el.chatInput.blur();
    this.el.chatInput.parentElement.style.display = 'none';
    this.g.requestPointer();
  }

  setPaused(v) { this.el.paused.style.display = v && !this.chatOpen ? 'flex' : 'none'; }
  setReloading(v) { this.el.reloadBar.style.display = v ? 'block' : 'none'; }

  onFire(hitPart) {
    if (hitPart) { this.hitMarker = 1; this.hitMarkerHead = hitPart === 'head'; }
  }
  onDamaged() { this.damageFlash = 1; }
  onKillConfirm() { this.killBanner = 1.6; }
  onDeath(byUid) {
    const r = this.g.remote.get(byUid);
    this.el.killer.textContent = r ? r.name : (byUid?.startsWith?.('bot') ? '机器人' : '对手');
    this.el.dead.style.display = 'flex';
  }
  onRespawn() { this.el.dead.style.display = 'none'; }

  pushKillfeed(killer, victim, weaponKey, headshot) {
    const w = WEAPONS[weaponKey];
    this.killfeed.push({ killer, victim, w: w ? w.short : '—', hs: headshot, t: performance.now() });
    if (this.killfeed.length > 5) this.killfeed.shift();
    this.renderKillfeed();
  }
  renderKillfeed() {
    this.el.kf.innerHTML = this.killfeed.map(k =>
      `<div class="kfrow"><b class="k">${esc(k.killer)}</b>
       <span class="w">${esc(k.w)}${k.hs ? ' ⌖' : ''}</span>
       <b class="v">${esc(k.victim)}</b></div>`).join('');
  }
  pushChat(who, msg) {
    this.chatLog.push({ who, msg, t: performance.now() });
    if (this.chatLog.length > 6) this.chatLog.shift();
    this.el.chat.innerHTML = this.chatLog.map(c =>
      `<div><b>${esc(c.who)}</b>：${esc(c.msg)}</div>`).join('');
  }

  update(dt) {
    const g = this.g, p = g.p;

    // 血条
    this.el.hp.textContent = Math.max(0, Math.round(p.health));
    this.el.shield.textContent = Math.max(0, Math.round(p.shield));
    this.el.hpBar.style.width = Math.max(0, p.health) + '%';
    this.el.shBar.style.width = Math.max(0, p.shield / 50 * 100) + '%';
    this.el.hpBar.classList.toggle('low', p.health <= 35);

    // 弹药
    const key = g.weaponKey, w = g.weapon;
    this.el.ammo.textContent = p.ammo[key];
    this.el.reserve.textContent = p.reserve[key];
    this.el.ammo.classList.toggle('low', p.ammo[key] <= Math.ceil(w.mag * 0.25));
    this.el.wname.textContent = w.name;

    // 准星随散布张开
    const state = { speed: Math.hypot(p.vel.x, p.vel.z), airborne: p.airborne, crouching: p.crouching };
    const spread = computeSpread(w, state);
    const gap = 3 + spread * 6 + (1 - Math.min(1, (performance.now() / 1000 - p.lastShot) / 0.3)) * 6;
    this.el.crosshair.style.setProperty('--gap', gap.toFixed(1) + 'px');
    this.el.crosshair.style.opacity = p.scoped ? 0 : 1;

    // 开镜黑边
    this.el.scopeOverlay.style.opacity = p.scopeT.toFixed(2);

    // 命中标记
    if (this.hitMarker > 0) {
      this.hitMarker -= dt * 4.5;
      this.el.crosshair.classList.add('hit');
      this.el.crosshair.classList.toggle('hs', this.hitMarkerHead);
    } else {
      this.el.crosshair.classList.remove('hit', 'hs');
    }

    // 受伤红屏
    if (this.damageFlash > 0) {
      this.damageFlash -= dt * 2.2;
      this.el.hitFlash.style.opacity = Math.max(0, this.damageFlash * 0.42).toFixed(2);
    } else this.el.hitFlash.style.opacity = 0;

    // 击杀提示
    if (this.killBanner > 0) {
      this.killBanner -= dt;
      this.el.killMsg.style.opacity = Math.min(1, this.killBanner).toFixed(2);
    } else this.el.killMsg.style.opacity = 0;

    // 死亡倒计时
    if (!p.alive) {
      const left = Math.max(0, (p.deadUntil - performance.now()) / 1000);
      this.el.deadTimer.textContent = left.toFixed(1);
    }

    // 换弹进度
    if (p.reloading > 0) {
      const k = 1 - p.reloading / w.reload;
      this.el.reloadBar.firstElementChild.style.width = (k * 100).toFixed(0) + '%';
    }

    // 记分板
    const showSb = !!g.keys['Tab'];
    this.el.scoreboard.style.display = showSb ? 'block' : 'none';
    if (showSb) this.renderScoreboard();

    // 击杀播报淘汰
    const now = performance.now();
    const before = this.killfeed.length;
    this.killfeed = this.killfeed.filter(k => now - k.t < 6000);
    if (this.killfeed.length !== before) this.renderKillfeed();
    this.chatLog = this.chatLog.filter(c => now - c.t < 12000);

    // 网络状态
    const n = g.net;
    if (n.offline) {
      this.el.netInfo.textContent = '离线 · 仅机器人';
      this.el.netInfo.style.color = '#cdd8e4';
    } else if (n.mode === 'p2p') {
      const ping = n.ping;
      this.el.netInfo.textContent = `P2P 直连 ${n.peerCount} 人 · ${ping}ms`;
      this.el.netInfo.style.color = ping < 60 ? '#55d18b' : ping < 120 ? '#e5b454' : '#e0564c';
    } else {
      this.el.netInfo.textContent = `中转模式 ${n.players.size} 人 · 连接中…`;
      this.el.netInfo.style.color = '#e5b454';
    }

    this.drawMinimap();
  }

  renderScoreboard() {
    const g = this.g;
    const rows = [{
      name: g.profile.name + '（你）', team: g.profile.team,
      k: g.p.kills, d: g.p.deaths, me: true,
    }];
    for (const [uid, r] of g.remote) {
      const m = g.net.players.get(uid)?.meta;
      rows.push({ name: r.name, team: r.team, k: m?.kills || 0, d: m?.deaths || 0 });
    }
    for (const b of g.bots.list) {
      rows.push({ name: b.name, team: b.team, k: b.kills, d: b.deaths, bot: true });
    }
    rows.sort((a, b) => b.k - a.k || a.d - b.d);
    this.el.sbBody.innerHTML = rows.map(r =>
      `<tr class="${r.me ? 'me' : ''}">
        <td><span class="dot ${r.team}"></span>${esc(r.name)}${r.bot ? ' <i>BOT</i>' : ''}</td>
        <td>${r.k}</td><td>${r.d}</td>
        <td>${r.d ? (r.k / r.d).toFixed(2) : r.k.toFixed(2)}</td>
      </tr>`).join('');
  }

  drawMinimap() {
    const g = this.g, c = this.mctx, S = 180;
    const sx = S / (MAP.bounds.x * 2), sz = S / (MAP.bounds.z * 2);
    const s = Math.min(sx, sz);
    const ox = S / 2, oz = S / 2;
    const W = (x) => ox + x * s, H = (z) => oz + z * s;

    c.clearRect(0, 0, S, S);
    c.fillStyle = 'rgba(14,18,24,.82)';
    c.fillRect(0, 0, S, S);

    // 墙
    c.fillStyle = 'rgba(190,200,215,.30)';
    for (const w of MAP.walls) {
      c.fillRect(W(w.p[0] - w.s[0] / 2), H(w.p[2] - w.s[2] / 2), w.s[0] * s, w.s[2] * s);
    }
    // 出生区
    for (const [team, col] of [['red', 'rgba(224,86,76,.35)'], ['blue', 'rgba(63,169,216,.35)']]) {
      c.fillStyle = col;
      const z = team === 'red' ? 22 : -22;
      c.fillRect(W(-11), H(z - 3), 22 * s, 6 * s);
    }

    // 其他玩家（只画队友 + 近距离敌人）
    const me = g.p.pos;
    const drawDot = (x, z, color, isMe) => {
      c.beginPath();
      c.arc(W(x), H(z), isMe ? 3.5 : 2.8, 0, Math.PI * 2);
      c.fillStyle = color; c.fill();
    };
    for (const [, r] of g.remote) {
      if (!r.alive) continue;
      const p = r.group.position;
      const same = r.team === g.profile.team;
      if (!same && Math.hypot(p.x - me.x, p.z - me.z) > 26) continue;
      drawDot(p.x, p.z, same ? '#5fd0ff' : '#ff6b5a', false);
    }
    for (const b of g.bots.list) {
      if (!b.alive) continue;
      const same = b.team === g.profile.team;
      if (!same && Math.hypot(b.pos.x - me.x, b.pos.z - me.z) > 26) continue;
      drawDot(b.pos.x, b.pos.z, same ? '#5fd0ff' : '#ff6b5a', false);
    }

    // 自己 + 视野扇形
    const ang = -g.p.yaw + Math.PI / 2;
    c.save();
    c.translate(W(me.x), H(me.z));
    c.rotate(-ang + Math.PI / 2);
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, 26, -Math.PI / 2 - 0.65, -Math.PI / 2 + 0.65);
    c.closePath();
    c.fillStyle = 'rgba(255,230,150,.18)';
    c.fill();
    c.restore();
    drawDot(me.x, me.z, '#ffe08a', true);

    // 边框
    c.strokeStyle = 'rgba(255,255,255,.14)';
    c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, S - 1, S - 1);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
