// ═══════════════════════════════════════════════════════════
//  地图定义 —— 纯数据，改这里就能改关卡
//  坐标系：X 左右，Y 上下，Z 前后。1 单位 = 1 米
// ═══════════════════════════════════════════════════════════
import * as THREE from 'three';

export const MAP = {
  name: '哈瓦那 · HAVANA',
  bounds: { x: 36, z: 26 },

  // 出生点（红队在南，蓝队在北）
  spawns: {
    red:  [[-6, 0, 21], [-2, 0, 22], [2, 0, 22], [6, 0, 21]],
    blue: [[-6, 0, -21], [-2, 0, -22], [2, 0, -22], [6, 0, -21]],
  },

  // 墙体与掩体：p = 中心点，s = 尺寸，c = 颜色，tall = 是否算高墙（阻挡视线）
  walls: [
    // ── 外围 ──
    { p: [0, 3, -26], s: [72, 6, 1.2], c: 0xd8cfc0 },
    { p: [0, 3, 26],  s: [72, 6, 1.2], c: 0xd8cfc0 },
    { p: [-36, 3, 0], s: [1.2, 6, 52], c: 0xd8cfc0 },
    { p: [36, 3, 0],  s: [1.2, 6, 52], c: 0xd8cfc0 },

    // ── 分隔左路 / 中路（中间留通道）──
    { p: [-13, 3, -16], s: [1.2, 6, 20], c: 0xc9bca8 },
    { p: [-13, 3, 16],  s: [1.2, 6, 20], c: 0xc9bca8 },
    // ── 分隔中路 / 右路 ──
    { p: [13, 3, -16], s: [1.2, 6, 20], c: 0xc9bca8 },
    { p: [13, 3, 16],  s: [1.2, 6, 20], c: 0xc9bca8 },

    // ── A 区（左）建筑 ──
    { p: [-25, 2.2, -10], s: [10, 4.4, 1.2], c: 0xcbb89c },
    { p: [-30, 2.2, -4],  s: [1.2, 4.4, 12], c: 0xcbb89c },
    { p: [-21, 1.1, 3],   s: [3.6, 2.2, 3.6], c: 0xa8906d },
    { p: [-29, 1.1, 9],   s: [5, 2.2, 2.4], c: 0xa8906d },
    { p: [-18, 1.1, -14], s: [2.4, 2.2, 5], c: 0xa8906d },
    { p: [-25, 0.6, 14],  s: [7, 1.2, 2.4], c: 0x8d7a5c },

    // ── 中路 ──
    { p: [0, 1.4, -7],  s: [7, 2.8, 1.6], c: 0xa8906d },
    { p: [-5, 1.1, 7],  s: [2.4, 2.2, 5], c: 0xa8906d },
    { p: [5, 1.1, 7],   s: [2.4, 2.2, 5], c: 0xa8906d },
    { p: [0, 0.6, 0],   s: [5, 1.2, 5], c: 0x8d7a5c },
    { p: [-8, 1.6, -16], s: [1.2, 3.2, 6], c: 0xc9bca8 },
    { p: [8, 1.6, -16],  s: [1.2, 3.2, 6], c: 0xc9bca8 },

    // ── B 区（右）建筑 ──
    { p: [25, 2.2, -10], s: [10, 4.4, 1.2], c: 0xcbb89c },
    { p: [30, 2.2, -4],  s: [1.2, 4.4, 12], c: 0xcbb89c },
    { p: [21, 1.1, 3],   s: [3.6, 2.2, 3.6], c: 0xa8906d },
    { p: [29, 1.1, 9],   s: [5, 2.2, 2.4], c: 0xa8906d },
    { p: [18, 1.1, -14], s: [2.4, 2.2, 5], c: 0xa8906d },
    { p: [25, 0.6, 14],  s: [7, 1.2, 2.4], c: 0x8d7a5c },

    // ── 出生区掩体 ──
    { p: [-16, 1.1, 21], s: [4, 2.2, 2.4], c: 0x8d7a5c },
    { p: [16, 1.1, 21],  s: [4, 2.2, 2.4], c: 0x8d7a5c },
    { p: [-16, 1.1, -21], s: [4, 2.2, 2.4], c: 0x8d7a5c },
    { p: [16, 1.1, -21],  s: [4, 2.2, 2.4], c: 0x8d7a5c },
  ],
};

// 从墙体数据生成 AABB 碰撞盒
export function buildColliders() {
  return MAP.walls.map(w => ({
    min: new THREE.Vector3(w.p[0] - w.s[0] / 2, w.p[1] - w.s[1] / 2, w.p[2] - w.s[2] / 2),
    max: new THREE.Vector3(w.p[0] + w.s[0] / 2, w.p[1] + w.s[1] / 2, w.p[2] + w.s[2] / 2),
  }));
}

// 构建可见几何体
export function buildScene(scene) {
  const group = new THREE.Group();

  // 地面
  const groundGeo = new THREE.PlaneGeometry(MAP.bounds.x * 2, MAP.bounds.z * 2);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xbfa882 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // 地面网格纹理（用线条暗示尺度）
  const grid = new THREE.GridHelper(MAP.bounds.x * 2, 36, 0x9c8664, 0x9c8664);
  grid.position.y = 0.02;
  grid.material.opacity = 0.25;
  grid.material.transparent = true;
  group.add(grid);

  // 墙体
  const shared = new Map();
  for (const w of MAP.walls) {
    if (!shared.has(w.c)) {
      shared.set(w.c, new THREE.MeshLambertMaterial({ color: w.c }));
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.s[0], w.s[1], w.s[2]), shared.get(w.c));
    mesh.position.set(w.p[0], w.p[1], w.p[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // 出生区地面着色
  for (const [team, col] of [['red', 0xe0564c], ['blue', 0x3fa9d8]]) {
    const z = team === 'red' ? 22 : -22;
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 6),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.14 })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.03, z);
    group.add(pad);
  }

  scene.add(group);
  return group;
}
