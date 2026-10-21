// ═══════════════════════════════════════════════════════════
//  机器人 AI（v2 重写）
//
//  v1 的三个毛病，这版针对性解决：
//   ① 只会躲墙后不出来
//      —— 原因不是「它想躲」，而是战斗中的移动完全不看碰撞，
//         撞墙后速度被清零就定在原地了；而且巡逻时一碰墙就
//         立刻重新随机选点，于是在墙角来回抽搐。
//      —— 现在：预先把地图采样成一张导航图（节点 + 可直走的连线），
//         用 A* 真正绕路；战斗中的走位会先探路，撞墙就换方向。
//   ② 枪太准
//      —— 原因是命中率上限 0.72、反应 0.15 秒、步枪 0.1 秒一发，
//         折算约 234 DPS，玩家 0.5 秒就倒。
//      —— 现在：反应 0.32~0.65 秒；点射 3~6 发后强制停顿；
//         刚发现目标的头两枪大幅降准；你在移动时更难被命中；
//         距离惩罚更陡；爆头率压到 4%~6%。
//   ③ 行为单调
//      —— 现在有 巡逻 / 推进 / 交战 / 找掩体 / 追击 五种状态，
//         血量低会退到掩体后，丢失目标会去最后出现的位置摸。
//
//  想调难度，直接改下面 TUNE 里的数。
// ═══════════════════════════════════════════════════════════
import * as THREE from 'three';
import { MAP } from './map.js';
import { WEAPONS, computeDamage } from './weapons.js';
import { rayAABB } from './game.js';

const BOT_NAMES = ['老六', '报点王', '苟到底', '手抖侠', '冲锋哥', '静步怪',
  '一枪一个', '键盘侠', '残局王', '天选之子', '送分童子', '别打我'];

// ── 手感调参区 ────────────────────────────────────────
const TUNE = {
  reactMin: 0.32,        // 反应时间下限（秒，技术最好的）
  reactMax: 0.68,        // 反应时间上限（技术最差的）
  hitBase: 0.13,         // 基础命中率
  hitBySkill: 0.28,      // 技术带来的命中率加成
  hitCap: 0.42,          // 命中率硬上限 —— 这是「别太准」的总闸门
  hitFloor: 0.03,
  distFree: 8,           // 这个距离内不吃距离惩罚（米）
  distScale: 22,         // 距离惩罚的尺度，越小惩罚越狠
  movingTargetMul: 0.62, // 目标在移动时的命中率乘数
  freshTargetMul: 0.45,  // 刚发现目标时头几枪的命中率乘数
  freshShots: 2,         // 「刚发现」算几发
  sprayPenalty: 0.12,    // 连发每多一发累加的失准（上限 50%）
  burstMin: 3, burstMax: 6,
  burstPauseMin: 0.22, burstPauseMax: 0.62,
  headBase: 0.02, headBySkill: 0.045,   // 爆头率 2%~6.5%
  loseSightGrace: 0.6,   // 丢失视野后还会朝原位置打多久
  coverHpRatio: 0.38,    // 血量低于这个比例就去找掩体
  speed: 3.4,
};

// ═══════════════════════════════════════════════════════════
//  导航图：把可站立的空地采样成节点，相邻且能直走的连起来
//  只在第一次用到时构建一次，之后所有机器人共用
// ═══════════════════════════════════════════════════════════
class NavGraph {
  constructor(colliders) {
    this.colliders = colliders;
    this.nodes = [];      // {x, z, nb:[索引...]}
    this.build();
  }

  // 这个点能不能站人（按机器人的身位盒判断）
  free(x, z) {
    const R = 0.55, H = 1.8;
    for (const c of this.colliders) {
      if (x + R <= c.min.x || x - R >= c.max.x) continue;
      if (H <= c.min.y || 0 >= c.max.y) continue;
      if (z + R <= c.min.z || z - R >= c.max.z) continue;
      return false;
    }
    return true;
  }

  // 两点之间能不能直着走过去。
  // 不能只打一条中线射线 —— 那样会贴着墙角「擦」过去。
  // 这里左右各偏 0.5 米再各打一条，三条都通才算通。
  walkable(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    const ux = dx / len, uz = dz / len;
    const px = -uz * 0.5, pz = ux * 0.5;       // 垂直偏移
    for (const o of [0, 1, -1]) {
      const from = new THREE.Vector3(ax + px * o, 0.9, az + pz * o);
      const dir = new THREE.Vector3(ux, 0, uz);
      const ray = new THREE.Ray(from, dir);
      for (const c of this.colliders) {
        const r = rayAABB(ray, c.min, c.max);
        if (r !== null && r.t < len) return false;
      }
    }
    return true;
  }

  build() {
    const STEP = 2.5, LINK = 3.7;
    const bx = MAP.bounds.x - 1.5, bz = MAP.bounds.z - 1.5;
    const grid = [];
    for (let x = -bx; x <= bx; x += STEP) {
      for (let z = -bz; z <= bz; z += STEP) {
        if (this.free(x, z)) grid.push({ x, z, nb: [] });
      }
    }
    this.nodes = grid;
    // 连边（只连近邻，省得 O(n²) 全连）
    for (let i = 0; i < grid.length; i++) {
      for (let j = i + 1; j < grid.length; j++) {
        const a = grid[i], b = grid[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > LINK) continue;
        if (!this.walkable(a.x, a.z, b.x, b.z)) continue;
        a.nb.push(j); b.nb.push(i);
      }
    }
  }

  nearest(x, z, mustReach = null) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (mustReach !== null && n.nb.length === 0) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // A*：返回节点索引数组（含终点，不含起点）；走不通返回 null
  path(si, gi) {
    if (si < 0 || gi < 0) return null;
    if (si === gi) return [];
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const f = new Float64Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const gn = this.nodes[gi];
    const h = (i) => Math.hypot(this.nodes[i].x - gn.x, this.nodes[i].z - gn.z);
    // 小二叉堆
    const heap = [];
    const push = (i) => {
      heap.push(i);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (f[heap[p]] <= f[heap[c]]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let p = 0;
        for (;;) {
          const l = p * 2 + 1, r = l + 1;
          let m = p;
          if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
          if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
          if (m === p) break;
          [heap[p], heap[m]] = [heap[m], heap[p]]; p = m;
        }
      }
      return top;
    };
    g[si] = 0; f[si] = h(si); push(si);
    while (heap.length) {
      const cur = pop();
      if (closed[cur]) continue;          // 堆里可能有重复项
      if (cur === gi) break;
      closed[cur] = 1;
      const cn = this.nodes[cur];
      for (const nb of cn.nb) {
        if (closed[nb]) continue;
        const nn = this.nodes[nb];
        const ng = g[cur] + Math.hypot(cn.x - nn.x, cn.z - nn.z);
        if (ng < g[nb]) { g[nb] = ng; f[nb] = ng + h(nb); from[nb] = cur; push(nb); }
      }
    }
    if (from[gi] === -1 && si !== gi) return null;
    const out = [];
    for (let c = gi; c !== -1 && c !== si; c = from[c]) out.push(c);
    return out.reverse();
  }
}

export class BotManager {
  constructor(game) {
    this.g = game;
    this.list = [];
    this.enabled = true;
    this.nav = null;                      // 第一次 update 时建，确保 colliders 已就绪
    this.namePool = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  }

  ensureNav() {
    if (!this.nav) this.nav = new NavGraph(this.g.colliders);
    return this.nav;
  }

  spawn(count, team) {
    for (let i = 0; i < count; i++) {
      const pts = MAP.spawns[team];
      const s = pts[i % pts.length];
      const skill = 0.3 + Math.random() * 0.55;
      const wkey = ['vandal', 'phantom', 'spectre', 'phantom'][Math.floor(Math.random() * 4)];
      const b = {
        id: 'bot_' + (this.list.length + 1),
        name: this.namePool.pop() || ('机器人' + (this.list.length + 1)),
        team,
        pos: new THREE.Vector3(s[0], 0, s[2]),
        vel: new THREE.Vector3(),
        // 和玩家同一套约定：forward = (-sin yaw, 0, -cos yaw)
        // 红队在南(z+)要朝 z- 看 → yaw 0；蓝队在北(z-)朝 z+ → yaw π
        yaw: team === 'red' ? 0 : Math.PI,
        health: 100, shield: 25, alive: true,
        kills: 0, deaths: 0,
        skill, weapon: WEAPONS[wkey], weaponKey: wkey,
        ammo: WEAPONS[wkey].mag,
        // AI 状态
        state: 'patrol', stateT: 0,
        target: null, lastSeen: null, lastSeenT: 0,
        reactT: 0, nextFire: 0, reloadT: 0,
        shotsThisBurst: 0, burstLen: 4, burstPause: 0,
        shotsOnTarget: 0,
        strafe: Math.random() < 0.5 ? -1 : 1, strafeT: 0,
        // 寻路
        path: null, pathIdx: 0, goal: null, repathT: 0,
        stuckT: 0, lastPos: new THREE.Vector3(s[0], 0, s[2]),
        deadUntil: 0, mesh: null,
      };
      this.buildMesh(b);
      this.list.push(b);
    }
  }

  buildMesh(b) {
    const col = b.team === 'red' ? 0xe0564c : 0x3fa9d8;
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: col });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2a2f36 });
    const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.42, 4, 8), dark);
    legs.position.y = 0.42; legs.castShadow = true; g.add(legs);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.5, 4, 10), mat);
    body.position.y = 1.12; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), mat);
    head.position.y = 1.65; head.castShadow = true; g.add(head);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.45), dark);
    gun.position.set(0.22, 1.25, -0.25); g.add(gun);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 18),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; g.add(ring);
    this.g.scene.add(g);
    b.mesh = g;
  }

  // ── 视线：两点之间有没有墙 ──
  losClear(from, to) {
    const dir = to.clone().sub(from);
    const dist = dir.length();
    if (dist < 0.01) return true;
    dir.normalize();
    const ray = new THREE.Ray(from, dir);
    for (const c of this.g.colliders) {
      const r = rayAABB(ray, c.min, c.max);
      if (r !== null && r.t < dist) return false;
    }
    return true;
  }

  // ── 找最近的可见敌人 ──
  findTarget(b) {
    const eye = b.pos.clone().setY(1.5);
    let best = null, bestD = 65;

    const consider = (pos, isPlayer, ref, alive, team, moving) => {
      if (!alive || team === b.team) return;
      const d = eye.distanceTo(pos);
      if (d > bestD) return;
      const to = pos.clone().sub(eye).normalize();
      const fwd = new THREE.Vector3(-Math.sin(b.yaw), 0, -Math.cos(b.yaw));
      if (to.dot(fwd) < 0.2 && d > 7) return;         // 视野约 ±78°，近身不受限
      if (!this.losClear(eye, pos)) return;
      bestD = d; best = { pos: pos.clone(), isPlayer, ref, dist: d, moving };
    };

    const p = this.g.p;
    const protectedNow = performance.now() < (p.protectUntil || 0);
    const pMoving = Math.hypot(p.vel.x, p.vel.z) > 1.6;
    consider(p.pos.clone().setY(p.pos.y - 0.2), true, null,
             p.alive && !protectedNow, this.g.profile.team, pMoving);
    for (const o of this.list) {
      if (o === b) continue;
      consider(o.pos.clone().setY(1.4), false, o, o.alive, o.team,
               Math.hypot(o.vel.x, o.vel.z) > 1.6);
    }
    for (const [uid, r] of this.g.remote) {
      consider(r.group.position.clone().setY(r.group.position.y + 1.4), false,
        { remoteUid: uid, ...r }, r.alive, r.team, true);
    }
    return best;
  }

  // ═══════════════════ 主循环 ═══════════════════
  update(dt, nowMs) {
    if (!this.enabled) return;
    this.ensureNav();
    for (const b of this.list) {
      if (!b.alive) {
        if (nowMs >= b.deadUntil) this.respawn(b);
        continue;
      }
      b.reloadT = Math.max(0, b.reloadT - dt);
      b.burstPause = Math.max(0, b.burstPause - dt);
      b.stateT += dt;
      b.strafeT -= dt;
      if (b.strafeT <= 0) { b.strafe = Math.random() < 0.5 ? -1 : 1; b.strafeT = 0.7 + Math.random() * 0.9; }

      // 目标获取 / 丢失
      const tgt = this.findTarget(b);
      if (tgt) {
        if (!b.target) {                       // 刚发现：进入反应延迟，头几枪发飘
          b.reactT = TUNE.reactMax - (TUNE.reactMax - TUNE.reactMin) * b.skill;
          b.shotsOnTarget = 0;
        }
        b.target = tgt;
        b.lastSeen = tgt.pos.clone();
        b.lastSeenT = 0;
      } else if (b.target) {
        b.lastSeenT += dt;
        if (b.lastSeenT > TUNE.loseSightGrace) b.target = null;
      }

      this.think(b, dt, nowMs);
      this.steer(b, dt);
      this.moveWithCollision(b, dt);

      b.mesh.position.copy(b.pos);
      b.mesh.rotation.y = b.yaw;     // 模型默认朝 -Z，和 forward 约定一致，不用再 +π
      b.mesh.visible = b.alive;
    }
  }

  // ── 状态选择 ──
  think(b, dt, nowMs) {
    const hpRatio = (b.health + b.shield) / 125;
    const prev = b.state;

    if (b.target) {
      // 血少了先退到掩体，而不是站在原地对枪
      b.state = (hpRatio < TUNE.coverHpRatio && b.stateT > 0.6) ? 'cover' : 'engage';
    } else if (b.lastSeen && b.lastSeenT < 6) {
      b.state = 'hunt';
    } else {
      b.state = 'patrol';
    }
    if (b.state !== prev) { b.stateT = 0; b.path = null; b.repathT = 0; }

    if (b.state === 'engage') this.combat(b, dt, nowMs);
    else if (b.state === 'cover') { this.seekCover(b, dt); this.combat(b, dt, nowMs, true); }
    else if (b.state === 'hunt') this.goTo(b, b.lastSeen, dt);
    else this.patrol(b, dt);
  }

  // ═══════════════════ 交战 ═══════════════════
  combat(b, dt, nowMs, suppressMove = false) {
    const t = b.target;
    if (!t) return;
    const eye = b.pos.clone().setY(1.5);

    // 转向目标：越菜转得越慢、抖得越厉害
    const want = Math.atan2(-(t.pos.x - eye.x), -(t.pos.z - eye.z));
    const jitter = Math.sin(nowMs / 150 + b.skill * 12) * (1 - b.skill) * 0.10;
    let da = want - b.yaw;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    b.yaw += da * Math.min(1, dt * (4 + b.skill * 8)) + jitter * dt;

    // 走位：保持交战距离 + 横向拉扯（会探路，撞墙自动换边）
    if (!suppressMove) {
      const ideal = b.weaponKey === 'spectre' ? 11 : 18;
      const push = t.dist > ideal ? 1 : t.dist < ideal * 0.5 ? -1 : 0;
      const fwd = new THREE.Vector3(-Math.sin(b.yaw), 0, -Math.cos(b.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      let dirX = fwd.x * push + right.x * b.strafe * 0.85;
      let dirZ = fwd.z * push + right.z * b.strafe * 0.85;
      // 探路：前方 1.6 米有墙就翻转横移方向，别再往墙里顶
      if (!this.clearAhead(b, dirX, dirZ, 1.6)) {
        b.strafe *= -1; b.strafeT = 0.5 + Math.random() * 0.5;
        dirX = fwd.x * push + right.x * b.strafe * 0.85;
        dirZ = fwd.z * push + right.z * b.strafe * 0.85;
        if (!this.clearAhead(b, dirX, dirZ, 1.6)) { dirX = 0; dirZ = 0; }
      }
      const l = Math.hypot(dirX, dirZ) || 1;
      b.vel.x = dirX / l * TUNE.speed;
      b.vel.z = dirZ / l * TUNE.speed;
    }

    // ── 开枪 ──
    b.reactT -= dt;
    if (b.reactT > 0 || b.reloadT > 0 || b.burstPause > 0) return;
    if (b.ammo <= 0) { b.reloadT = b.weapon.reload; b.ammo = b.weapon.mag; b.shotsOnTarget = 0; return; }
    const nowS = nowMs / 1000;
    if (nowS < b.nextFire) return;
    if (Math.abs(da) > 0.16) return;             // 还没瞄过来就不开枪

    b.nextFire = nowS + b.weapon.rof;
    b.ammo--;
    b.shotsThisBurst++;
    b.shotsOnTarget++;

    // 点射纪律：打几发就得停一下，不能无脑长按
    if (b.shotsThisBurst >= b.burstLen) {
      b.shotsThisBurst = 0;
      b.burstLen = TUNE.burstMin + Math.floor(Math.random() * (TUNE.burstMax - TUNE.burstMin + 1));
      b.burstPause = TUNE.burstPauseMin + Math.random() * (TUNE.burstPauseMax - TUNE.burstPauseMin);
    }

    // ── 命中判定 ──
    let ch = TUNE.hitBase + b.skill * TUNE.hitBySkill;
    ch /= 1 + Math.max(0, t.dist - TUNE.distFree) / TUNE.distScale;   // 距离惩罚
    if (t.moving) ch *= TUNE.movingTargetMul;                         // 你在动更难打中
    if (b.shotsOnTarget <= TUNE.freshShots) ch *= TUNE.freshTargetMul; // 头几枪发飘
    ch *= 1 - Math.min(0.5, Math.max(0, b.shotsThisBurst - 1) * TUNE.sprayPenalty); // 连发后坐
    ch = Math.max(TUNE.hitFloor, Math.min(TUNE.hitCap, ch));

    if (Math.random() < ch) {
      const head = Math.random() < (TUNE.headBase + b.skill * TUNE.headBySkill);
      const part = head ? 'head' : (Math.random() < 0.22 ? 'legs' : 'body');
      const dmg = computeDamage(b.weapon, part, t.dist);
      if (t.isPlayer) {
        this.g.takeDamage(dmg, b.id, part, b.weaponKey);
        if (!this.g.p.alive) {
          b.kills++;
          this.g.hud.pushKillfeed(b.name, '你', b.weaponKey, head);
        }
      } else if (t.ref && !t.ref.remoteUid) {
        this.damage(t.ref, dmg, part, b.weaponKey, b);
      }
    }
    // 弹道特效（不管打不打中都要画，否则你看不到有人在打你）
    const dir = new THREE.Vector3(t.pos.x - eye.x, t.pos.y - eye.y, t.pos.z - eye.z).normalize();
    this.g.spawnTracer(eye, eye.clone().addScaledVector(dir, Math.min(t.dist, 60)), false);
  }

  // ═══════════════════ 找掩体 ═══════════════════
  // 在附近找一个「看不到目标」的节点躲过去，而不是原地挨打
  seekCover(b, dt) {
    const nav = this.nav;
    if (b.repathT > 0) { b.repathT -= dt; this.followPath(b); return; }
    b.repathT = 1.2;
    const t = b.target;
    if (!t) return;
    let best = -1, bd = Infinity;
    const from = b.pos;
    for (let i = 0; i < nav.nodes.length; i++) {
      const n = nav.nodes[i];
      const d = Math.hypot(n.x - from.x, n.z - from.z);
      if (d > 16 || d < 2) continue;
      // 这个点看不到目标 → 是掩体
      if (this.losClear(new THREE.Vector3(n.x, 1.5, n.z), t.pos)) continue;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      const si = nav.nearest(b.pos.x, b.pos.z);
      const pth = nav.path(si, best);
      if (pth) { b.path = pth; b.pathIdx = 0; }
    }
    this.followPath(b);
  }

  // ═══════════════════ 巡逻 / 推进 ═══════════════════
  patrol(b, dt) {
    const nav = this.nav;
    b.repathT -= dt;
    const needGoal = !b.path || b.pathIdx >= b.path.length || b.repathT <= 0;
    if (needGoal) {
      b.repathT = 5 + Math.random() * 4;
      // 往对方半场推进（红队在南 z+，所以往 z- 走）
      const sign = b.team === 'red' ? -1 : 1;
      const cands = [];
      for (let i = 0; i < nav.nodes.length; i++) {
        const n = nav.nodes[i];
        if (n.nb.length === 0) continue;
        if (Math.sign(n.z) === sign && Math.abs(n.z) > 6) cands.push(i);
      }
      if (cands.length) {
        const gi = cands[Math.floor(Math.random() * cands.length)];
        const si = nav.nearest(b.pos.x, b.pos.z);
        const pth = nav.path(si, gi);
        if (pth && pth.length) { b.path = pth; b.pathIdx = 0; }
      }
    }
    this.followPath(b);
  }

  // 去某个具体坐标（追击最后出现的位置）
  goTo(b, dest, dt) {
    if (!dest) { this.patrol(b, dt); return; }
    const nav = this.nav;
    b.repathT -= dt;
    if (!b.path || b.pathIdx >= b.path.length || b.repathT <= 0) {
      b.repathT = 1.5;
      const si = nav.nearest(b.pos.x, b.pos.z);
      const gi = nav.nearest(dest.x, dest.z);
      const pth = nav.path(si, gi);
      if (pth) { b.path = pth; b.pathIdx = 0; }
      if (b.pos.distanceTo(dest) < 2.5) { b.lastSeen = null; b.lastSeenT = 99; }
    }
    this.followPath(b);
  }

  // ── 沿路径走 ──
  followPath(b) {
    if (!b.path || b.pathIdx >= b.path.length) { b.vel.x = 0; b.vel.z = 0; return; }
    const n = this.nav.nodes[b.path[b.pathIdx]];
    const dx = n.x - b.pos.x, dz = n.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.4) { b.pathIdx++; return; }
    b.vel.x = dx / d * TUNE.speed;
    b.vel.z = dz / d * TUNE.speed;
    // 朝走的方向看
    const want = Math.atan2(-dx, -dz);
    let da = want - b.yaw;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    b.yaw += da * Math.min(1, 0.08);
  }

  // 朝某方向 dist 米内有没有墙
  clearAhead(b, dx, dz, dist) {
    const l = Math.hypot(dx, dz);
    if (l < 1e-5) return true;
    const ray = new THREE.Ray(
      new THREE.Vector3(b.pos.x, 0.9, b.pos.z),
      new THREE.Vector3(dx / l, 0, dz / l));
    for (const c of this.g.colliders) {
      const r = rayAABB(ray, c.min, c.max);
      if (r !== null && r.t < dist) return false;
    }
    return true;
  }

  // 卡住检测放在 steer 里：真的没挪动就重新规划
  steer(b, dt) {
    const moved = b.pos.distanceTo(b.lastPos);
    const wants = Math.hypot(b.vel.x, b.vel.z) > 0.5;
    if (wants && moved < 0.02) b.stuckT += dt;
    else b.stuckT = Math.max(0, b.stuckT - dt * 2);
    b.lastPos.copy(b.pos);
    if (b.stuckT > 0.7) {
      b.stuckT = 0;
      b.path = null; b.repathT = 0;        // 重新找路
      b.strafe *= -1;
      // 轻微随机侧移，帮它从墙角里脱出来
      const a = Math.random() * Math.PI * 2;
      b.vel.x = Math.cos(a) * TUNE.speed;
      b.vel.z = Math.sin(a) * TUNE.speed;
    }
  }

  // ── 逐轴碰撞：撞墙只停那一个轴，另一个轴照走（贴墙滑行）──
  moveWithCollision(b, dt) {
    const R = 0.4;
    const tryAxis = (axis) => {
      const before = b.pos[axis];
      b.pos[axis] += b.vel[axis] * dt;
      const lo = { x: b.pos.x - R, y: b.pos.y, z: b.pos.z - R };
      const hi = { x: b.pos.x + R, y: b.pos.y + 1.8, z: b.pos.z + R };
      for (const c of this.g.colliders) {
        if (hi.x <= c.min.x || lo.x >= c.max.x) continue;
        if (hi.y <= c.min.y || lo.y >= c.max.y) continue;
        if (hi.z <= c.min.z || lo.z >= c.max.z) continue;
        b.pos[axis] = before;
        b.vel[axis] = 0;
        return;
      }
    };
    tryAxis('x');
    tryAxis('z');
    b.pos.x = Math.max(-MAP.bounds.x + 1, Math.min(MAP.bounds.x - 1, b.pos.x));
    b.pos.z = Math.max(-MAP.bounds.z + 1, Math.min(MAP.bounds.z - 1, b.pos.z));
    b.pos.y = 0;
  }

  damage(b, dmg, part, weaponKey, from) {
    if (!b.alive) return;
    let left = dmg;
    if (b.shield > 0) {
      const a = Math.min(b.shield, Math.ceil(left * 0.66));
      b.shield -= a; left -= a;
    }
    b.health -= left;
    // 被打了要有反应：朝来的方向警觉（如果还不知道敌人在哪）
    if (from && !b.target) { b.lastSeen = from.pos.clone(); b.lastSeenT = 0; }
    if (b.health <= 0) {
      b.alive = false;
      b.deaths++;
      b.deadUntil = performance.now() + 4000;
      b.mesh.visible = false;
      if (from) { from.kills++; }
      else {
        this.g.p.kills++;
        this.g.hud.onKillConfirm();
        this.g.hud.pushKillfeed('你', b.name, weaponKey, part === 'head');
      }
    }
  }

  respawn(b) {
    const pts = MAP.spawns[b.team];
    const s = pts[Math.floor(Math.random() * pts.length)];
    b.pos.set(s[0], 0, s[2]);
    b.lastPos.copy(b.pos);
    b.yaw = b.team === 'red' ? 0 : Math.PI;
    b.health = 100; b.shield = 25; b.alive = true;
    b.ammo = b.weapon.mag; b.reloadT = 0;
    b.target = null; b.lastSeen = null; b.lastSeenT = 99;
    b.state = 'patrol'; b.stateT = 0;
    b.path = null; b.pathIdx = 0; b.repathT = 0; b.stuckT = 0;
    b.shotsThisBurst = 0; b.burstPause = 0; b.shotsOnTarget = 0;
    b.mesh.visible = true;
  }

  clear() {
    for (const b of this.list) this.g.scene.remove(b.mesh);
    this.list = [];
  }
}
