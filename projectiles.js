// ═══════════════════════════════════════════════════════════
//  投掷物系统 —— 飞刀这类有飞行时间和下坠的武器
//  和子弹不同：子弹是瞬时射线，飞刀要一帧帧飞，打提前量
// ═══════════════════════════════════════════════════════════
import * as THREE from 'three';
import { computeDamage } from './weapons.js';
import { rayAABB, raySegmentCapsule } from './game.js';

export class ProjectileSystem {
  constructor(game) {
    this.g = game;
    this.list = [];
    this.stuck = [];        // 插在墙上的刀，留一会儿做视觉
    this._geo = null;
  }

  bladeMesh(color = 0xaab4c0) {
    if (!this._geo) {
      // 菱形刀身 + 短柄
      const s = new THREE.Shape();
      s.moveTo(0, 0.11); s.lineTo(0.022, 0); s.lineTo(0, -0.05); s.lineTo(-0.022, 0);
      s.closePath();
      this._geo = new THREE.ExtrudeGeometry(s, { depth: 0.006, bevelEnabled: false });
      this._geo.center();
    }
    const g = new THREE.Group();
    const blade = new THREE.Mesh(this._geo,
      new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    g.add(blade);
    const grip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.009, 0.06, 6),
      new THREE.MeshLambertMaterial({ color: 0x2a2520 }));
    grip.position.y = -0.085;
    g.add(grip);
    return g;
  }

  // owner: 'me' | uid | bot对象；local 表示由我判定命中
  spawn(origin, dir, weapon, weaponKey, owner, local) {
    const P = weapon.projectile;
    const mesh = this.bladeMesh(local ? 0xcfd8e2 : 0xd8a0a0);
    mesh.position.copy(origin);
    this.g.scene.add(mesh);
    this.list.push({
      pos: origin.clone(),
      prev: origin.clone(),
      vel: dir.clone().multiplyScalar(P.speed),
      gravity: P.gravity,
      radius: P.radius,
      spin: P.spin,
      roll: 0,
      weapon, weaponKey, owner, local,
      mesh, life: 6,
    });
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) { this.remove(i); continue; }

      p.prev.copy(p.pos);
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.roll += p.spin * dt;

      // 刀尖朝飞行方向，并绕自身轴旋转
      const dir = p.vel.clone().normalize();
      p.mesh.position.copy(p.pos);
      p.mesh.lookAt(p.pos.clone().add(dir));
      p.mesh.rotateX(Math.PI / 2);
      p.mesh.rotateY(p.roll);

      // 用这一帧走过的线段做碰撞（避免高速穿透）
      const seg = p.pos.clone().sub(p.prev);
      const segLen = seg.length();
      if (segLen < 1e-5) continue;
      const ray = new THREE.Ray(p.prev, seg.clone().normalize());

      // ① 打人
      if (p.local) {
        let best = null, bestD = segLen + p.radius;
        for (const [uid, ent] of this.g.enemyEntities()) {
          if (!ent.alive) continue;
          const segs = [
            { name: 'head', y0: 1.50, y1: 1.80, r: 0.19 + p.radius },
            { name: 'body', y0: 0.72, y1: 1.50, r: 0.34 + p.radius },
            { name: 'legs', y0: 0.00, y1: 0.72, r: 0.30 + p.radius },
          ];
          for (const sg of segs) {
            const d = raySegmentCapsule(ray, ent.position, sg.y0, sg.y1, sg.r);
            if (d !== null && d < bestD) { bestD = d; best = { uid, part: sg.name, ent, d }; }
          }
        }
        if (best) {
          const dist = this.g.p.pos.distanceTo(best.ent.position);
          const dmg = computeDamage(p.weapon, best.part, dist);
          this.g.applyHit(best.uid, dmg, best.part, p.weaponKey, best.ent);
          this.g.hud.onFire(best.part);
          this.burst(p.pos, 0xd8604a);
          this.remove(i);
          continue;
        }
      }

      // ② 打墙 → 插上去
      let hitT = Infinity, hitPt = null, hitN = null;
      for (const c of this.g.colliders) {
        const r = rayAABB(ray, c.min, c.max);
        if (r !== null && r.t <= segLen && r.t < hitT) { hitT = r.t; hitPt = r.point; hitN = r.normal; }
      }
      if (hitPt) {
        this.stick(p, hitPt, hitN);
        this.remove(i);
        continue;
      }

      // ③ 打到地面 → 插在地上（之前会穿过地面飞到地下才消失）
      if (p.pos.y <= 0.02) {
        const k = p.prev.y > 0.02 ? (p.prev.y - 0.02) / Math.max(1e-5, p.prev.y - p.pos.y) : 0;
        const gp = p.prev.clone().lerp(p.pos, k);
        gp.y = 0.02;
        this.stick(p, gp, new THREE.Vector3(0, 1, 0));
        this.remove(i);
        continue;
      }

      // ④ 出界
      if (Math.abs(p.pos.x) > 40 || Math.abs(p.pos.z) > 30) this.remove(i);
    }

    // 插在墙上的刀逐渐消失
    for (let i = this.stuck.length - 1; i >= 0; i--) {
      const s = this.stuck[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.g.scene.remove(s.mesh);
        this.stuck.splice(i, 1);
      } else if (s.life < 1.5) {
        s.mesh.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = s.life / 1.5; } });
      }
    }
  }

  stick(p, point, normal) {
    const m = p.mesh;
    m.position.copy(point).addScaledVector(normal, -0.04);
    const dir = p.vel.clone().normalize();
    m.lookAt(point.clone().add(dir));
    m.rotateX(Math.PI / 2);
    this.stuck.push({ mesh: m, life: 6 });
    p.mesh = null;          // 转交给 stuck，别在 remove 里删掉
    this.burst(point, 0x8a94a0, 5);
  }

  burst(pos, color, n = 8) {
    for (let i = 0; i < n; i++) {
      this.g.spawnTracer(pos,
        pos.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5)),
        false);
    }
  }

  remove(i) {
    const p = this.list[i];
    if (p.mesh) this.g.scene.remove(p.mesh);
    this.list.splice(i, 1);
  }

  clear() {
    for (const p of this.list) if (p.mesh) this.g.scene.remove(p.mesh);
    for (const s of this.stuck) this.g.scene.remove(s.mesh);
    this.list = []; this.stuck = [];
  }
}
