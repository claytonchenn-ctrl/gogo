// ═══════════════════════════════════════════════════════════
//  核心引擎：玩家控制 / 碰撞 / 射击 / 渲染
// ═══════════════════════════════════════════════════════════
import * as THREE from 'three';
import { MAP, buildColliders, buildScene } from './map.js';
import { WEAPONS, LOADOUTS, computeDamage, computeSpread, sprayOffset } from './weapons.js';
import { Net, FLAG, INTERP_MS } from './net.js';
import { FIREBASE_CONFIG } from './config.js';
import { BotManager } from './bots.js';
import { HUD } from './hud.js';
import { ProjectileSystem } from './projectiles.js';

// ── 常量 ──
const EYE_H = 1.65, CROUCH_H = 1.1, RADIUS = 0.42;
const STEP_H = 0.62;        // 能直接迈上去的台阶高度，不用跳
const SPD_RUN = 6.0, SPD_WALK = 2.9, SPD_CROUCH = 2.3;
const ACCEL_GROUND = 60, ACCEL_AIR = 9, FRICTION = 11;
const GRAVITY = 20, JUMP_V = 6.0;
const RESPAWN_MS = 4000;
const PHYS_STEP = 1 / 120, MAX_STEPS = 8;
const SPAWN_PROTECT_MS = 1800;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Game {
  constructor(profile) {
    this.profile = profile;
    this.colliders = buildColliders();
    this.net = new Net();
    this.clock = new THREE.Clock();
    this.remote = new Map();      // uid -> { group, parts, label }
    this.decals = [];
    this.tracers = [];
    this.running = false;
    this.paused = false;
    this.killfeed = [];
    this.setupThree();
    this.hud = new HUD(this);      // 必须在 setupPlayer 之前：respawn() 会回调 hud
    this.setupPlayer();
    this.setupInput();
    this.bots = new BotManager(this);
    this.proj = new ProjectileSystem(this);
  }

  // ───────────────────────── 场景 ─────────────────────────
  setupThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xa9c4d8);
    this.scene.fog = new THREE.Fog(0xa9c4d8, 60, 140);

    this.camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.05, 400);
    this.baseFov = 80;

    this.renderer = new THREE.WebGLRenderer({
      canvas: document.getElementById('gl'), antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.add(new THREE.HemisphereLight(0xdfeaf2, 0x8a7a5e, 1.5));
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.7);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 50;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 140 });
    this.scene.add(sun);

    buildScene(this.scene);

    // 视角模型挂在相机上
    this.viewGroup = new THREE.Group();
    this.camera.add(this.viewGroup);
    this.scene.add(this.camera);

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.hud.resize();
    });
  }

  // ───────────────────────── 玩家 ─────────────────────────
  setupPlayer() {
    const lo = LOADOUTS[this.profile.loadout] || LOADOUTS[0];
    this.p = {
      pos: new THREE.Vector3(0, EYE_H, 20),
      vel: new THREE.Vector3(),
      yaw: 0, pitch: 0,
      height: EYE_H, crouching: false, airborne: false,
      health: 100, shield: 50, alive: true,
      kills: 0, deaths: 0,
      deadUntil: 0,
      loadout: lo,
      slots: [lo.primary, lo.secondary],
      weaponIdx: 0,
      ammo: {}, reserve: {},
      reloading: 0, nextFire: 0, shotIndex: 0, lastShot: 0,
      recoilPitch: 0, recoilYaw: 0, recoilVel: 0,
      scoped: false, scopeT: 0, protectUntil: 0,
      spinT: 0, burstLeft: 0, burstNext: 0, dualSide: 1,
      bob: 0, sway: new THREE.Vector2(),
      flash: 0,
    };
    for (const k of this.p.slots) {
      this.p.ammo[k] = WEAPONS[k].mag;
      this.p.reserve[k] = WEAPONS[k].reserve;
    }
    this.buildViewModel();
    this.respawn(true);
  }

  get weapon() { return WEAPONS[this.p.slots[this.p.weaponIdx]]; }
  get weaponKey() { return this.p.slots[this.p.weaponIdx]; }

  buildViewModel() {
    this.viewGroup.clear();
    const m = { ...this.weapon.model, slot: this.weapon.slot };
    const g = new THREE.Group();
    const matBody = new THREE.MeshLambertMaterial({ color: m.col });
    const matDark = new THREE.MeshLambertMaterial({ color: 0x15181d });
    const matMetal = new THREE.MeshLambertMaterial({ color: 0x4e5560 });
    const matHand = new THREE.MeshLambertMaterial({ color: 0x8a6a4e });

    // 机匣（主体）—— 飞刀没有机匣
    if (!m.blade) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(m.w, m.h * 0.78, m.len), matBody);
      body.position.set(0, 0, -m.len / 2);
      g.add(body);
    }

    // 上机匣 / 导轨
    if (!m.blade) {
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(m.w * 0.72, m.h * 0.3, m.len * 0.82), matDark);
    top.position.set(0, m.h * 0.5, -m.len * 0.46);
    g.add(top);
    }

    // 枪管
    if (m.minigun) {
      // 六根管子绕一圈，开火时整组旋转
      const cluster = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const tube = new THREE.Mesh(
          new THREE.CylinderGeometry(m.w * 0.16, m.w * 0.16, m.barrel, 8), matMetal);
        tube.rotation.x = Math.PI / 2;
        tube.position.set(Math.cos(a) * m.w * 0.34, Math.sin(a) * m.w * 0.34, 0);
        cluster.add(tube);
      }
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(m.w * 0.5, m.w * 0.5, m.barrel * 0.18, 12), matDark);
      hub.rotation.x = Math.PI / 2;
      hub.position.z = -m.barrel * 0.4;
      cluster.add(hub);
      cluster.position.set(0, m.h * 0.04, -m.len - m.barrel / 2 + 0.01);
      g.add(cluster);
      this.barrelSpin = cluster;          // updateCamera 里按预热程度旋转
    } else if (m.revolver) {
      const barrel = new THREE.Mesh(
        new THREE.BoxGeometry(m.w * 0.5, m.h * 0.3, m.barrel), matMetal);
      barrel.position.set(0, m.h * 0.14, -m.len - m.barrel / 2 + 0.01);
      g.add(barrel);
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(m.w * 0.78, m.w * 0.78, m.len * 0.22, 8), matMetal);
      cyl.rotation.x = Math.PI / 2;
      cyl.position.set(0, -m.h * 0.04, -m.len * 0.42);
      g.add(cyl);
      this.barrelSpin = cyl;
    } else if (m.blade) {
      // 飞刀：手里捏一把，不是枪
      const bl = new THREE.Mesh(new THREE.ConeGeometry(m.w * 1.6, m.len, 4), matMetal);
      bl.rotation.set(Math.PI / 2, 0, Math.PI / 4);
      bl.position.set(0, 0, -m.len * 0.55);
      g.add(bl);
      const gr = new THREE.Mesh(
        new THREE.CylinderGeometry(m.w * 0.7, m.w * 0.7, m.len * 0.4, 6), matDark);
      gr.rotation.x = Math.PI / 2;
      gr.position.set(0, 0, m.len * 0.06);
      g.add(gr);
      this.barrelSpin = null;
    } else {
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(m.w * 0.26, m.w * 0.26, m.barrel, 10), matMetal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, m.h * 0.04, -m.len - m.barrel / 2 + 0.01);
      g.add(barrel);
      this.barrelSpin = null;
    }

    // 握把（向后下倾斜）
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(m.w * 0.85, m.h * 1.15, m.h * 0.52), matDark);
    grip.position.set(0, -m.h * 0.72, -m.len * 0.26);
    grip.rotation.x = 0.32;
    g.add(grip);

    // 弹匣（飞刀 / 左轮没有）
    if (!m.blade && !m.revolver) {
    const mag = new THREE.Mesh(
      new THREE.BoxGeometry(m.w * 0.72, m.h * 1.05, m.h * 0.44), matDark);
    mag.position.set(0, -m.h * 0.68, -m.len * 0.5);
    mag.rotation.x = -0.12;
    g.add(mag);
    }

    // 枪托（手枪和飞刀没有）
    if (!m.blade && !m.revolver && m.slot !== 2) {
      const stock = new THREE.Mesh(
        new THREE.BoxGeometry(m.w * 0.8, m.h * 0.62, m.len * 0.3), matBody);
      stock.position.set(0, -m.h * 0.12, m.len * 0.12);
      g.add(stock);
    }

    // 瞄具
    if (m.scopeTop) {
      const sc = new THREE.Mesh(
        new THREE.CylinderGeometry(m.w * 0.42, m.w * 0.42, m.len * 0.34, 12), matDark);
      sc.rotation.x = Math.PI / 2;
      sc.position.set(0, m.h * 0.82, -m.len * 0.5);
      g.add(sc);
      for (const z of [-m.len * 0.36, -m.len * 0.64]) {
        const mount = new THREE.Mesh(
          new THREE.BoxGeometry(m.w * 0.3, m.h * 0.3, m.len * 0.05), matDark);
        mount.position.set(0, m.h * 0.65, z);
        g.add(mount);
      }
    } else {
      // 准星柱 + 照门
      const fs = new THREE.Mesh(
        new THREE.BoxGeometry(m.w * 0.16, m.h * 0.3, m.len * 0.04), matDark);
      fs.position.set(0, m.h * 0.76, -m.len * 0.93);
      g.add(fs);
      const rs = new THREE.Mesh(
        new THREE.BoxGeometry(m.w * 0.5, m.h * 0.22, m.len * 0.05), matDark);
      rs.position.set(0, m.h * 0.72, -m.len * 0.1);
      g.add(rs);
    }

    // 握枪的手
    const handR = new THREE.Mesh(
      new THREE.BoxGeometry(m.w * 1.5, m.h * 0.8, m.h * 0.6), matHand);
    handR.position.set(0, -m.h * 1.05, -m.len * 0.22);
    handR.rotation.x = 0.3;
    g.add(handR);
    const handL = new THREE.Mesh(
      new THREE.BoxGeometry(m.w * 1.6, m.h * 0.7, m.h * 0.75), matHand);
    handL.position.set(-m.w * 0.2, -m.h * 0.72, -m.len * 0.72);
    g.add(handL);

    // 枪口焰
    this.muzzle = new THREE.Mesh(
      new THREE.ConeGeometry(0.05, 0.15, 7),
      new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0 }));
    this.muzzle.rotation.x = -Math.PI / 2;
    this.muzzle.position.set(0, m.h * 0.04, -m.len - m.barrel - 0.05);
    g.add(this.muzzle);

    // 关键：fov 80 下枪离相机太近会被透视放大成一堵墙。
    // 拉远 + 缩小，让它看起来是"握在手里的枪"而不是"贴在脸上的箱子"
    g.scale.setScalar(0.62);
    g.position.set(0.175, -0.145, -0.40);
    g.rotation.set(0.02, -0.045, 0);
    this.viewGroup.add(g);
    this.vm = g;
    this.vmRest = g.position.clone();
  }

  // ───────────────────────── 输入 ─────────────────────────
  setupInput() {
    this.keys = {};
    this.mouse = { down: false, sens: this.profile.sens || 1.0 };

    addEventListener('keydown', e => {
      if (e.code === 'Tab') e.preventDefault();
      if (this.hud.chatOpen) return;
      this.keys[e.code] = true;
      if (e.code === 'KeyR') this.startReload();
      if (e.code === 'Digit1') this.switchWeapon(0);
      if (e.code === 'Digit2') this.switchWeapon(1);
      if (e.code === 'KeyQ') this.switchWeapon(this.p.weaponIdx === 0 ? 1 : 0);
      if (e.code === 'KeyT') this.hud.openChat();
      if (e.code === 'Escape') this.releasePointer();
    });
    addEventListener('keyup', e => { this.keys[e.code] = false; });

    const cv = this.renderer.domElement;
    cv.addEventListener('mousedown', e => {
      if (!this.pointerLocked) { this.requestPointer(); return; }
      if (e.button === 0) this.mouse.down = true;
      if (e.button === 2 && this.weapon.scope) this.p.scoped = !this.p.scoped;
    });
    addEventListener('mouseup', e => { if (e.button === 0) this.mouse.down = false; });
    cv.addEventListener('contextmenu', e => e.preventDefault());

    addEventListener('mousemove', e => {
      if (!this.pointerLocked) return;
      // 必须同时判断「这把枪有镜」并给默认值：
      // 否则 scoped 残留在没有镜的枪上时 scopeSpeed 是 undefined → 灵敏度 NaN → 视角彻底废掉
      const zoom = (this.p.scoped && this.weapon.scope) ? (this.weapon.scopeSpeed || 0.4) : 1;
      const s = 0.0022 * this.mouse.sens * zoom;
      this.p.yaw -= e.movementX * s;
      this.p.pitch -= e.movementY * s;
      this.p.pitch = Math.max(-1.54, Math.min(1.54, this.p.pitch));
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === cv;
      this.hud.setPaused(!this.pointerLocked);
      if (!this.pointerLocked) this.mouse.down = false;
    });
  }
  requestPointer() { this.renderer.domElement.requestPointerLock?.(); }
  releasePointer() { document.exitPointerLock?.(); }

  // ───────────────────────── 碰撞 ─────────────────────────
  // 逐轴分离的 AABB 解算：先 X 再 Z 再 Y，每轴推出重叠
  // 【改】原来命中第一个碰撞盒就 return，夹在两个盒子之间时只解算一个，
  // 于是会卡进墙角或被反复弹来弹去。现在遍历所有盒子，每次推出后重算包围盒。
  // 水平轴还加了「抬腿上台阶」：矮台（≤ STEP_H）直接抬上去，不再被硬挡住。
  collideAxis(axis) {
    const pp = this.p.pos;
    for (const c of this.colliders) {
      const h = this.p.height;
      const lo = { x: pp.x - RADIUS, y: pp.y - h, z: pp.z - RADIUS };
      const hi = { x: pp.x + RADIUS, y: pp.y + 0.15, z: pp.z + RADIUS };
      if (hi.x <= c.min.x || lo.x >= c.max.x) continue;
      if (hi.y <= c.min.y || lo.y >= c.max.y) continue;
      if (hi.z <= c.min.z || lo.z >= c.max.z) continue;

      if (axis === 'y') {
        const pushD = c.min.y - hi.y, pushU = c.max.y - lo.y;
        if (Math.abs(pushU) < Math.abs(pushD)) {   // 站到物体上
          pp.y += pushU; this.p.vel.y = 0; this.p.airborne = false;
        } else {                                    // 顶到天花板
          pp.y += pushD; this.p.vel.y = Math.min(0, this.p.vel.y);
        }
        continue;
      }

      // 水平轴：先试试能不能抬腿迈上去
      const rise = c.max.y - lo.y;
      if (rise > 0 && rise <= STEP_H && this.p.vel.y <= 0.1) {
        const saveY = pp.y;
        pp.y += rise + 0.02;
        if (this.fitsHere()) { this.p.vel.y = 0; this.p.airborne = false; continue; }
        pp.y = saveY;                               // 上面没空间，老实被挡住
      }

      if (axis === 'x') {
        const pushL = c.min.x - hi.x, pushR = c.max.x - lo.x;
        pp.x += Math.abs(pushL) < Math.abs(pushR) ? pushL : pushR;
        this.p.vel.x = 0;
      } else {
        const pushF = c.min.z - hi.z, pushB = c.max.z - lo.z;
        pp.z += Math.abs(pushF) < Math.abs(pushB) ? pushF : pushB;
        this.p.vel.z = 0;
      }
    }
  }

  // 当前身位有没有和任何墙体重叠（抬腿上台阶时用来确认上面是空的）
  fitsHere() {
    const p = this.p.pos, h = this.p.height;
    for (const c of this.colliders) {
      if (p.x + RADIUS <= c.min.x || p.x - RADIUS >= c.max.x) continue;
      if (p.y + 0.15 <= c.min.y || p.y - h >= c.max.y) continue;
      if (p.z + RADIUS <= c.min.z || p.z - RADIUS >= c.max.z) continue;
      return false;
    }
    return true;
  }

  // 上方是否有空间站起来
  canStand() {
    const p = this.p.pos;
    const lo = new THREE.Vector3(p.x - RADIUS, p.y - CROUCH_H, p.z - RADIUS);
    const hi = new THREE.Vector3(p.x + RADIUS, p.y + (EYE_H - CROUCH_H) + 0.15, p.z + RADIUS);
    for (const c of this.colliders) {
      if (hi.x <= c.min.x || lo.x >= c.max.x) continue;
      if (hi.y <= c.min.y || lo.y >= c.max.y) continue;
      if (hi.z <= c.min.z || lo.z >= c.max.z) continue;
      return false;
    }
    return true;
  }

  // ───────────────────────── 移动 ─────────────────────────
  updateMovement(dt) {
    const p = this.p;
    if (!p.alive) { p.vel.set(0, 0, 0); return; }

    // 蹲伏（平滑过渡）
    const wantCrouch = !!this.keys['ControlLeft'] || !!this.keys['KeyC'];
    if (wantCrouch) p.crouching = true;
    else if (p.crouching && this.canStand()) p.crouching = false;
    const targetH = p.crouching ? CROUCH_H : EYE_H;
    p.height += (targetH - p.height) * Math.min(1, dt * 12);

    // 输入方向
    let ix = 0, iz = 0;
    if (this.keys['KeyW']) iz -= 1;
    if (this.keys['KeyS']) iz += 1;
    if (this.keys['KeyA']) ix -= 1;
    if (this.keys['KeyD']) ix += 1;
    const len = Math.hypot(ix, iz);
    if (len > 0) { ix /= len; iz /= len; }

    const walking = !!this.keys['ShiftLeft'];
    let maxSpd = p.crouching ? SPD_CROUCH : walking ? SPD_WALK : SPD_RUN;
    const heavy = this.weapon.moveSlow;          // 扛重武器走不快
    if (heavy) maxSpd *= heavy;

    // 把输入方向从「本地」转到「世界」。
    // three.js 里绕 Y 旋转 yaw 后：
    //   前方 forward = (-sin, 0, -cos)      右方 right = (cos, 0, -sin)
    // 所以 wish = ix*right + (-iz)*forward，展开就是下面两行。
    // 【曾经的 BUG】两行的 sin 项符号都写反了，等于按 -yaw 旋转：
    // 正前 / 正后看时碰巧正确，视角转到侧面时 A/D 完全反向。
    const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw);
    const wishX = ix * cos + iz * sin;
    const wishZ = -ix * sin + iz * cos;

    const accel = p.airborne ? ACCEL_AIR : ACCEL_GROUND;
    p.vel.x += wishX * accel * dt;
    p.vel.z += wishZ * accel * dt;

    // 地面摩擦：只在松开方向键时生效，否则会吃掉最高速
    // （有输入 → 加速到限速；无输入 → 强摩擦急停，这是战术射击的手感）
    if (!p.airborne && len === 0) {
      const sp = Math.hypot(p.vel.x, p.vel.z);
      if (sp > 0) {
        const drop = Math.max(sp, 3) * FRICTION * dt;
        const k = Math.max(0, sp - drop) / sp;
        p.vel.x *= k; p.vel.z *= k;
      }
    }
    // 限速
    const sp = Math.hypot(p.vel.x, p.vel.z);
    if (sp > maxSpd) { p.vel.x *= maxSpd / sp; p.vel.z *= maxSpd / sp; }

    // 跳跃
    if (this.keys['Space'] && !p.airborne) { p.vel.y = JUMP_V; p.airborne = true; }

    p.vel.y -= GRAVITY * dt;

    // 逐轴推进 + 解算
    p.pos.x += p.vel.x * dt; this.collideAxis('x');
    p.pos.z += p.vel.z * dt; this.collideAxis('z');
    p.airborne = true;
    p.pos.y += p.vel.y * dt; this.collideAxis('y');

    // 地面
    if (p.pos.y - p.height <= 0) { p.pos.y = p.height; p.vel.y = 0; p.airborne = false; }

    // 边界夹紧
    p.pos.x = Math.max(-MAP.bounds.x + 1, Math.min(MAP.bounds.x - 1, p.pos.x));
    p.pos.z = Math.max(-MAP.bounds.z + 1, Math.min(MAP.bounds.z - 1, p.pos.z));

    // 走路摆动
    const hs = Math.hypot(p.vel.x, p.vel.z);
    if (!p.airborne && hs > 0.5) p.bob += dt * hs * 1.5;
    else p.bob += dt * 1.2;
  }

  // ───────────────────────── 射击 ─────────────────────────
  updateShooting(dt, now) {
    const p = this.p;
    if (p.reloading > 0) {
      p.reloading -= dt;
      if (p.reloading <= 0) this.finishReload();
      return;
    }
    if (!p.alive) return;

    // 连发计数衰减（停火一会儿弹道重置）
    if (now - p.lastShot > 0.4) p.shotIndex = 0;

    const w = this.weapon, key = this.weaponKey;
    const empty = p.ammo[key] <= 0;

    // 弹夹空了就自动换弹 —— 这段必须放在预热判定【之前】。
    // 【曾经的 BUG】绞肉机空仓后 want 变 false → 转速掉下去 → spunUp 永远为 false
    // → 下面的 startReload 再也走不到，枪彻底变哑，只能手动按 R。
    if (empty && this.mouse.down) { this.startReload(); this.decayRecoil(dt, p); return; }

    // 机枪预热：按住左键先空转，转满才出弹
    if (w.spinUp) {
      const want = this.mouse.down && !empty;
      p.spinT = clamp(p.spinT + (want ? dt : -dt * 1.6), 0, w.spinUp);
    } else p.spinT = 0;

    // 连发武器：扣一次扳机打固定发数
    if (p.burstLeft > 0) {
      if (now >= p.burstNext) {
        if (p.ammo[key] > 0) { this.fire(now); p.burstLeft--; p.burstNext = now + w.burstDelay; }
        else p.burstLeft = 0;
      }
      if (p.burstLeft === 0) p.nextFire = now + w.rof;
      this.decayRecoil(dt, p);
      return;
    }

    // 【改】连发枪（斗牛犬）之前被当成半自动，按住不放只打一轮 3 发就再也不响。
    // 现在按住会按 rof 的节奏一轮接一轮地打。
    const repeats = w.auto || !!w.burst;
    const spunUp = !w.spinUp || p.spinT >= w.spinUp;
    const wantFire = this.mouse.down && (repeats || !this._firedThisClick) && spunUp;
    if (wantFire && now >= p.nextFire) {
      if (w.burst) { p.burstLeft = w.burst; p.burstNext = now; }
      else this.fire(now);
      if (!repeats) this._firedThisClick = true;
    }
    if (!this.mouse.down) this._firedThisClick = false;
    this.decayRecoil(dt, p);
  }

  decayRecoil(dt, p) {

    p.recoilVel += (-p.recoilPitch * 46 - p.recoilVel * 13) * dt;
    p.recoilPitch += p.recoilVel * dt;
    p.recoilYaw *= Math.max(0, 1 - dt * 7);
    p.flash = Math.max(0, p.flash - dt * 14);
  }

  fire(now) {
    const p = this.p, w = this.weapon, key = this.weaponKey;
    p.ammo[key]--;
    p.nextFire = now + w.rof;
    p.lastShot = now;

    const state = {
      speed: Math.hypot(p.vel.x, p.vel.z),
      airborne: p.airborne, crouching: p.crouching,
    };
    const spreadDeg = computeSpread(w, state) * (p.scoped ? 0.25 : 1);
    const [sx, sy] = sprayOffset(w, p.shotIndex);
    p.shotIndex++;

    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const muzzlePos = this.muzzleWorld();

    // 投掷物武器：不走射线，扔出一把会下坠的刀
    if (w.projectile) {
      const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(
        p.pitch + p.recoilPitch + (sy + (Math.random() - 0.5) * spreadDeg) * Math.PI / 180,
        p.yaw + p.recoilYaw + (sx + (Math.random() - 0.5) * spreadDeg) * Math.PI / 180, 0, 'YXZ'));
      this.proj.spawn(muzzlePos, dir, w, key, 'me', true);
      p.recoilVel += w.recoilKick * 0.09;
      p.flash = 0.3;
      this.vm.position.z += 0.05;
      this.net.sendThrow(muzzlePos, dir, key);
      return;
    }

    if (w.dual) p.dualSide *= -1;
    const shots = w.pellets || 1;
    let anyHit = null;

    for (let i = 0; i < shots; i++) {
      const extra = w.pellets ? w.pelletSpread : 0;
      const dev = (deg) => (deg * Math.PI / 180);
      const rx = (Math.random() - 0.5) * (spreadDeg + extra);
      const ry = (Math.random() - 0.5) * (spreadDeg + extra);
      const dir = new THREE.Vector3(0, 0, -1)
        .applyEuler(new THREE.Euler(
          p.pitch + p.recoilPitch + dev(sy + ry),
          p.yaw + p.recoilYaw + dev(sx + rx), 0, 'YXZ'));
      const hit = this.traceShot(origin, dir, w, key, muzzlePos);
      if (hit) anyHit = hit;
    }

    // 后坐力：视角被推上去
    p.recoilVel += w.recoilKick * 0.09;
    p.recoilYaw += (Math.random() - 0.5) * w.recoilKick * 0.008;
    p.flash = 1;
    this.vm.position.z += 0.035 * w.recoilKick;

    this.net.sendShot(muzzlePos,
      new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(p.pitch, p.yaw, 0, 'YXZ')), key);
    this.hud.onFire(anyHit);
  }

  // 枪口的世界坐标 —— 弹道视觉从这里发出（判定仍用相机射线）
  muzzleWorld() {
    if (!this.muzzle) return this.camera.getWorldPosition(new THREE.Vector3());
    return this.muzzle.getWorldPosition(new THREE.Vector3());
  }

  // 射线检测：先打玩家，再打墙
  traceShot(origin, dir, w, key, visualFrom) {
    const vFrom = visualFrom || origin;
    const ray = new THREE.Ray(origin, dir);
    let best = null, bestDist = w.range;

    // 对所有敌人做胶囊近似检测（头 / 身 / 腿三段）
    for (const [uid, ent] of this.enemyEntities()) {
      if (!ent.alive) continue;
      const base = ent.position;   // 脚底
      const segs = [
        { name: 'head', y0: 1.52, y1: 1.78, r: 0.17 },
        { name: 'body', y0: 0.75, y1: 1.52, r: 0.33 },
        { name: 'legs', y0: 0.00, y1: 0.75, r: 0.28 },
      ];
      for (const s of segs) {
        const d = raySegmentCapsule(ray, base, s.y0, s.y1, s.r);
        if (d !== null && d < bestDist) {
          bestDist = d; best = { uid, part: s.name, dist: d, ent };
        }
      }
    }

    // 墙体遮挡：如果墙比玩家更近，这一枪打墙上
    let wallDist = Infinity, wallPoint = null, wallNormal = null;
    for (const c of this.colliders) {
      const r = rayAABB(ray, c.min, c.max);
      if (r !== null && r.t < wallDist && r.t < w.range) {
        wallDist = r.t; wallPoint = r.point; wallNormal = r.normal;
      }
    }

    if (best && bestDist < wallDist) {
      const dmg = computeDamage(w, best.part, bestDist);
      this.applyHit(best.uid, dmg, best.part, key, best.ent);
      this.spawnTracer(vFrom, ray.at(bestDist, new THREE.Vector3()), true);
      return best.part;
    }
    if (wallPoint) {
      this.spawnDecal(wallPoint, wallNormal);
      this.spawnTracer(vFrom, wallPoint, false);
    } else {
      this.spawnTracer(vFrom, ray.at(w.range, new THREE.Vector3()), false);
    }
    return null;
  }

  // 返回所有可被击中的敌对实体（真人 + 机器人）
  *enemyEntities() {
    for (const [uid, r] of this.remote) {
      if (r.team === this.profile.team) continue;
      yield [uid, { position: r.group.position, alive: r.alive, isBot: false, ref: r }];
    }
    for (const b of this.bots.list) {
      if (b.team === this.profile.team) continue;
      yield [b.id, { position: b.pos, alive: b.alive, isBot: true, ref: b }];
    }
  }

  applyHit(uid, dmg, part, key, ent) {
    if (ent.isBot) {
      this.bots.damage(ent.ref, dmg, part, key);
    } else {
      this.net.sendHit(uid, dmg, part, key);
      // 本地立即给出反馈（真实血量以对方为准）
      const r = this.remote.get(uid);
      if (r) r.predictedHp = Math.max(0, (r.predictedHp ?? 100) - dmg);
    }
  }

  takeDamage(dmg, fromUid, part, weaponKey) {
    const p = this.p;
    if (!p.alive) return;
    if (performance.now() < p.protectUntil) return;   // 出生保护期内免伤
    let left = dmg;
    if (p.shield > 0) {
      const absorb = Math.min(p.shield, Math.ceil(left * 0.66));
      p.shield -= absorb; left -= absorb;
    }
    p.health -= left;
    this.hud.onDamaged(fromUid);
    if (p.health <= 0) {
      p.health = 0; p.alive = false; p.deaths++;
      p.deadUntil = performance.now() + RESPAWN_MS;
      this.net.sendDeath(fromUid, weaponKey, part);  // 由死者广播：告诉凶手他拿了人头
      this.hud.onDeath(fromUid);
    }
  }

  startReload() {
    const p = this.p, key = this.weaponKey, w = this.weapon;
    if (p.reloading > 0 || p.ammo[key] >= w.mag || p.reserve[key] <= 0) return;
    p.reloading = w.reload;
    this.hud.setReloading(true);
  }
  finishReload() {
    const p = this.p, key = this.weaponKey, w = this.weapon;
    const need = w.mag - p.ammo[key];
    const take = Math.min(need, p.reserve[key]);
    p.ammo[key] += take; p.reserve[key] -= take;
    p.shotIndex = 0;
    this.hud.setReloading(false);
  }
  switchWeapon(i) {
    if (i === this.p.weaponIdx || !this.p.alive) return;
    if (this.p.reloading > 0) {          // 换枪打断换弹
      this.p.reloading = 0;
      this.hud.setReloading(false);
    }
    this.p.weaponIdx = i;
    this.p.scoped = false;
    this.p.shotIndex = 0;
    this.p.spinT = 0; this.p.burstLeft = 0;
    this.p.nextFire = performance.now() / 1000 + 0.35;
    this.buildViewModel();
  }

  respawn(initial = false) {
    const p = this.p;
    const pts = MAP.spawns[this.profile.team] || MAP.spawns.red;
    const s = pts[Math.floor(Math.random() * pts.length)];
    p.pos.set(s[0], EYE_H, s[2]);
    p.vel.set(0, 0, 0);
    p.health = 100; p.shield = 50; p.alive = true;
    p.height = EYE_H; p.crouching = false;
    p.yaw = this.profile.team === 'red' ? 0 : Math.PI;   // 面朝战场，不是背对
    p.pitch = 0; p.recoilPitch = 0; p.recoilVel = 0;
    for (const k of p.slots) { p.ammo[k] = WEAPONS[k].mag; p.reserve[k] = WEAPONS[k].reserve; }
    p.weaponIdx = 0; p.shotIndex = 0; p.reloading = 0;
    p.spinT = 0; p.burstLeft = 0;
    p.scoped = false; p.scopeT = 0;      // 【改】原来没清，开镜中死亡会带着镜重生
    this._firedThisClick = false;
    p.protectUntil = performance.now() + SPAWN_PROTECT_MS;
    if (!initial) this.buildViewModel();
    this.hud?.onRespawn();
  }

  // ───────────────────────── 特效 ─────────────────────────
  spawnDecal(point, normal) {
    const geo = new THREE.CircleGeometry(0.055, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x1a1512, transparent: true, opacity: 0.85, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(point).addScaledVector(normal, 0.012);
    m.lookAt(point.clone().add(normal));
    this.scene.add(m);
    this.decals.push({ mesh: m, born: performance.now() });
    if (this.decals.length > 90) {
      const old = this.decals.shift();
      this.scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose();
    }
  }

  spawnTracer(from, to, isHit) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const mat = new THREE.LineBasicMaterial({
      color: isHit ? 0xffd27a : 0xfff0c8, transparent: true, opacity: 0.55,
    });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, born: performance.now() });
  }

  updateEffects(dt, nowMs) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      const age = (nowMs - t.born) / 90;
      if (age >= 1) {
        this.scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose();
        this.tracers.splice(i, 1);
      } else t.line.material.opacity = 0.55 * (1 - age);
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      const age = (nowMs - d.born) / 15000;
      if (age >= 1) {
        this.scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose();
        this.decals.splice(i, 1);
      } else if (age > 0.7) d.mesh.material.opacity = 0.85 * (1 - (age - 0.7) / 0.3);
    }
    this.muzzle.material.opacity = this.p.flash * 0.9;
    this.muzzle.scale.setScalar(0.8 + this.p.flash * 0.5);
  }

  // ─────────────────── 远端玩家模型 ───────────────────
  ensureRemote(uid, meta) {
    let r = this.remote.get(uid);
    if (r) return r;
    const team = meta?.team || 'blue';
    const col = team === 'red' ? 0xe0564c : 0x3fa9d8;
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

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.42, 20),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; g.add(ring);

    this.scene.add(g);
    r = { group: g, head, body, legs, gun, team, alive: true, predictedHp: 100,
          name: meta?.name || '玩家', lastSeen: performance.now() };
    this.remote.set(uid, r);
    return r;
  }

  updateRemotes() {
    for (const [uid] of this.net.players) {
      const s = this.net.interpolate(uid);
      if (!s) continue;
      const r = this.ensureRemote(uid, s.meta);
      r.name = s.meta.name || r.name;
      r.team = s.meta.team || r.team;
      r.alive = !(s.flags & FLAG.DEAD) && (s.meta.health ?? 100) > 0;
      r.predictedHp = s.meta.health ?? r.predictedHp;
      r.group.visible = r.alive;
      r.group.position.set(s.pos[0], s.pos[1] - EYE_H, s.pos[2]);
      r.group.rotation.y = s.rot[0] + Math.PI;
      const crouch = !!(s.flags & FLAG.CROUCH);
      r.group.scale.y = crouch ? 0.68 : 1;
      r.lastSeen = performance.now();
    }
    // 清理掉线的
    for (const [uid, r] of this.remote) {
      if (!this.net.players.has(uid)) {
        this.scene.remove(r.group);
        this.remote.delete(uid);
      }
    }
  }

  // ───────────────────────── 主循环 ─────────────────────────
  start() {
    this.running = true;
    this.clock.start();
    this.loop();
  }

  loop = () => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const nowMs = performance.now();
    const now = nowMs / 1000;
    try {
      if (this.pointerLocked && !this.hud.chatOpen) {
        // 固定步长物理：60fps 和 144fps 手感必须一样，低帧率也不能漂移
        this._acc = (this._acc || 0) + dt;
        let steps = 0;
        while (this._acc >= PHYS_STEP && steps < MAX_STEPS) {
          this.updateMovement(PHYS_STEP);
          this._acc -= PHYS_STEP;
          steps++;
        }
        if (steps >= MAX_STEPS) this._acc = 0;   // 卡顿时丢弃积压，避免死亡螺旋
        // 必须先把相机同步到本帧位置，再处理射击。
        // 否则开枪用的是上一帧的相机朝向，快速转身时准星和弹道会差一帧。
        this.updateCamera(dt);
        this.camera.updateMatrixWorld(true);
        this.updateShooting(dt, now);
        this._cameraSynced = true;
      } else this._cameraSynced = false;
      // 死亡倒计时
      if (!this.p.alive && nowMs >= this.p.deadUntil) this.respawn();

      this.bots.update(dt, nowMs);
      this.proj.update(dt);
      this.updateRemotes();
      this.updateEffects(dt, nowMs);
      if (!this._cameraSynced) this.updateCamera(dt);
      this.syncNet();
      this.hud.update(dt);
      this.renderer.render(this.scene, this.camera);
    } catch (e) {
      console.error('[frame]', e);
    }
  };

  updateCamera(dt) {
    const p = this.p;
    // 开镜 FOV
    const targetFov = p.scoped && this.weapon.scope ? this.weapon.scopeFov : this.baseFov;
    p.scopeT += ((p.scoped ? 1 : 0) - p.scopeT) * Math.min(1, dt * 14);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);
    this.camera.updateProjectionMatrix();

    this.camera.position.copy(p.pos);
    this.camera.rotation.set(p.pitch + p.recoilPitch, p.yaw + p.recoilYaw, 0, 'YXZ');

    // 视角模型：呼吸 + 走路摆动 + 回正
    const hs = Math.hypot(p.vel.x, p.vel.z);
    const bobAmp = Math.min(1, hs / SPD_RUN) * (p.crouching ? 0.4 : 1);
    const bx = Math.sin(p.bob * 2) * 0.012 * bobAmp;
    const by = Math.abs(Math.cos(p.bob * 2)) * 0.009 * bobAmp;
    const rest = this.vmRest;
    const hideScope = p.scoped ? 0.25 : 0;
    this.vm.position.x += (rest.x + bx - hideScope * 1.2 - this.vm.position.x) * Math.min(1, dt * 12);
    this.vm.position.y += (rest.y - by + hideScope * 0.08 - this.vm.position.y) * Math.min(1, dt * 12);
    this.vm.position.z += (rest.z - this.vm.position.z) * Math.min(1, dt * 10);
    this.vm.rotation.z = Math.sin(p.bob) * 0.02 * bobAmp;

    // 六管机枪：预热到哪转多快，松手慢慢停下
    if (this.barrelSpin && this.weapon.spinUp) {
      const k = p.spinT / this.weapon.spinUp;
      this.barrelSpin.rotation.z += dt * k * 26;
    }
  }

  syncNet() {
    const p = this.p;
    let flags = 0;
    if (p.crouching) flags |= FLAG.CROUCH;
    if (Math.hypot(p.vel.x, p.vel.z) > 1) flags |= FLAG.MOVE;
    if (!p.alive) flags |= FLAG.DEAD;
    if (p.scoped) flags |= FLAG.SCOPE;
    this.net.sendState({
      pos: p.pos, yaw: p.yaw, pitch: p.pitch,
      health: p.health, shield: p.shield,
      weaponIdx: p.weaponIdx, flags,
      kills: p.kills, deaths: p.deaths,
    });
  }

  // ─────────────────── 网络事件接入 ───────────────────
  bindNet() {
    this.net.on('hit', e => {
      this.takeDamage(e.dmg, e.by, e.part, e.w);
    });
    this.net.on('kill', e => {
      if (e.by === this.net.uid) { this.p.kills++; this.hud.onKillConfirm(); }
      const killer = e.by === this.net.uid ? '你' : (this.remote.get(e.by)?.name || '玩家');
      const victim = e.to === this.net.uid ? '你' : (this.remote.get(e.to)?.name || '玩家');
      this.hud.pushKillfeed(killer, victim, e.w, e.part === 'head');
    });
    this.net.on('shot', e => {
      const from = new THREE.Vector3(e.o[0], e.o[1], e.o[2]);
      const dir = new THREE.Vector3(e.d[0], e.d[1], e.d[2]);
      this.spawnTracer(from, from.clone().addScaledVector(dir, 60), false);
    });
    this.net.on('throw', e => {
      const w = WEAPONS[e.w];
      if (!w || !w.projectile) return;
      this.proj.spawn(new THREE.Vector3(e.o[0], e.o[1], e.o[2]),
        new THREE.Vector3(e.d[0], e.d[1], e.d[2]), w, e.w, e.by, false);
    });
    this.net.on('chat', e => {
      const who = e.by === this.net.uid ? '你' : (this.remote.get(e.by)?.name || '玩家');
      this.hud.pushChat(who, e.msg);
    });
    this.net.on('leave', uid => {
      const r = this.remote.get(uid);
      if (r) { this.scene.remove(r.group); this.remote.delete(uid); }
    });
  }
}

// ═══════════════ 射线数学 ═══════════════

// 射线 vs 竖直胶囊（近似为圆柱 + 端点球）
export function raySegmentCapsule(ray, base, y0, y1, radius) {
  const o = ray.origin, d = ray.direction;
  const cx = base.x, cz = base.z;
  // 先在 XZ 平面解圆柱
  const dx = o.x - cx, dz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  const b = 2 * (dx * d.x + dz * d.z);
  const c = dx * dx + dz * dz - radius * radius;
  if (a < 1e-8) return null;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t < 0) continue;
    const y = o.y + d.y * t - base.y;
    if (y >= y0 && y <= y1) return t;
  }
  return null;
}

// 射线 vs AABB（slab 法），返回命中距离、点、法线
export function rayAABB(ray, min, max) {
  const o = ray.origin, d = ray.direction;
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 1;
  const comp = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const k = comp[i];
    if (Math.abs(d[k]) < 1e-8) {
      if (o[k] < min[k] || o[k] > max[k]) return null;
      continue;
    }
    const inv = 1 / d[k];
    let t1 = (min[k] - o[k]) * inv, t2 = (max[k] - o[k]) * inv, s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin < 0) return null;
  const point = new THREE.Vector3(o.x + d.x * tmin, o.y + d.y * tmin, o.z + d.z * tmin);
  const normal = new THREE.Vector3(
    axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
  return { t: tmin, point, normal };
}
