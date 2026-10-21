// ═══════════════════════════════════════════════════════════
//  武器定义
//  dmg: [身体, 头部, 腿部]  ·  rof: 射击间隔(秒)  ·  spread: 基础散布(度)
//  spray: 固定弹道偏移 [水平, 垂直]（度），背下来就能压枪
// ═══════════════════════════════════════════════════════════

export const WEAPONS = {
  classic: {
    name: '制式手枪', short: 'CLASSIC', slot: 2, auto: false,
    dmg: [26, 78, 22], rof: 0.15, mag: 12, reserve: 60, reload: 1.5,
    spread: 0.35, moveMul: 2.6, airMul: 5, crouchMul: 0.72,
    falloff: { start: 30, end: 50, mul: 0.77 },
    recoilKick: 0.55, range: 120,
    spray: [[0,0],[0,-0.5],[0.2,-0.9],[-0.2,-1.2],[0.3,-1.4],[-0.3,-1.6]],
    model: { len: 0.26, w: 0.05, h: 0.14, col: 0x3a3f48, barrel: 0.08 },
  },

  spectre: {
    name: '幽灵冲锋枪', short: 'SPECTRE', slot: 1, auto: true,
    dmg: [26, 78, 22], rof: 0.0909, mag: 30, reserve: 90, reload: 2.2,
    spread: 0.5, moveMul: 1.45, airMul: 3.2, crouchMul: 0.7,
    falloff: { start: 20, end: 40, mul: 0.8 },
    recoilKick: 0.4, range: 90,
    spray: [[0,0],[0,-0.4],[0,-0.8],[0.1,-1.1],[-0.2,-1.4],[0.3,-1.6],
            [-0.4,-1.8],[0.5,-1.9],[-0.5,-2.0],[0.6,-2.1],[-0.7,-2.15],[0.8,-2.2]],
    model: { len: 0.4, w: 0.06, h: 0.16, col: 0x2e3238, barrel: 0.12 },
  },

  vandal: {
    name: '暴徒突击步枪', short: 'VANDAL', slot: 1, auto: true,
    dmg: [40, 160, 34], rof: 0.1034, mag: 25, reserve: 75, reload: 2.5,
    spread: 0.3, moveMul: 3.4, airMul: 6, crouchMul: 0.68,
    falloff: null,                       // 全距离同伤害，爆头必杀
    recoilKick: 0.9, range: 150,
    spray: [[0,0],[0,-0.6],[0,-1.2],[0,-1.7],[0.1,-2.1],[-0.2,-2.4],
            [0.4,-2.6],[-0.5,-2.75],[0.7,-2.85],[-0.9,-2.9],[1.1,-2.95],[-1.2,-3.0],
            [1.4,-3.0],[-1.5,-3.05],[1.6,-3.05]],
    model: { len: 0.52, w: 0.06, h: 0.17, col: 0x4a3b2c, barrel: 0.16 },
  },

  phantom: {
    name: '幻影突击步枪', short: 'PHANTOM', slot: 1, auto: true,
    dmg: [39, 156, 33], rof: 0.0909, mag: 30, reserve: 90, reload: 2.5,
    spread: 0.28, moveMul: 3.2, airMul: 5.6, crouchMul: 0.68,
    falloff: { start: 30, end: 50, mul: 0.87 },   // 远距离掉伤，近战更稳
    recoilKick: 0.75, range: 150,
    spray: [[0,0],[0,-0.55],[0,-1.05],[0,-1.5],[0.1,-1.85],[-0.15,-2.15],
            [0.3,-2.35],[-0.4,-2.5],[0.55,-2.6],[-0.7,-2.68],[0.85,-2.74],[-1.0,-2.78],
            [1.15,-2.8],[-1.25,-2.82],[1.35,-2.84]],
    model: { len: 0.48, w: 0.06, h: 0.16, col: 0x33383f, barrel: 0.14 },
  },

  operator: {
    name: '战地狙击枪', short: 'OPERATOR', slot: 1, auto: false,
    dmg: [160, 255, 130], rof: 1.5, mag: 5, reserve: 15, reload: 3.7,
    spread: 0.05, moveMul: 14, airMul: 20, crouchMul: 0.9,
    falloff: null,
    recoilKick: 3.2, range: 300, scope: true, scopeFov: 28, scopeSpeed: 0.35,
    spray: [[0,0]],
    model: { len: 0.72, w: 0.055, h: 0.15, col: 0x2a2f36, barrel: 0.26, scopeTop: true },
  },

  judge: {
    name: '审判者霰弹枪', short: 'JUDGE', slot: 1, auto: true,
    dmg: [26, 52, 22], rof: 0.25, mag: 7, reserve: 21, reload: 2.8,
    spread: 0.6, moveMul: 1.2, airMul: 2.4, crouchMul: 0.85,
    falloff: { start: 7, end: 25, mul: 0.26 },
    pellets: 7, pelletSpread: 2.6,
    recoilKick: 1.6, range: 35,
    spray: [[0,0],[0,-1.2],[0.4,-2.0],[-0.5,-2.6]],
    model: { len: 0.46, w: 0.07, h: 0.18, col: 0x5a4632, barrel: 0.18 },
  },

  // ───────────── 手枪类 ─────────────
  sheriff: {
    name: '左轮·治安官', short: 'SHERIFF', slot: 2, auto: false,
    dmg: [55, 159, 47], rof: 0.4, mag: 6, reserve: 24, reload: 2.3,
    spread: 0.22, moveMul: 4.2, airMul: 7, crouchMul: 0.62,
    falloff: { start: 30, end: 50, mul: 0.82 },
    recoilKick: 2.1, range: 140,
    spray: [[0,0],[0,-1.6],[0.5,-2.4],[-0.6,-3.0]],
    model: { len: 0.3, w: 0.05, h: 0.15, col: 0x6b5340, barrel: 0.14, revolver: true },
    flavor: '六发。打不中就只能骂街。',
  },

  twins: {
    name: '双子·连珠手枪', short: 'TWINS', slot: 2, auto: true,
    dmg: [23, 69, 20], rof: 0.08, mag: 26, reserve: 78, reload: 2.2,
    spread: 0.62, moveMul: 1.9, airMul: 3.4, crouchMul: 0.78,
    falloff: { start: 15, end: 30, mul: 0.72 },
    recoilKick: 0.5, range: 70, dual: true,
    spray: [[0.3,-0.3],[-0.4,-0.7],[0.5,-1.0],[-0.6,-1.3],[0.7,-1.5],[-0.8,-1.7],
            [0.9,-1.8],[-1.0,-1.9],[1.1,-2.0],[-1.2,-2.05]],
    model: { len: 0.24, w: 0.045, h: 0.13, col: 0x8a7a5c, barrel: 0.07 },
    flavor: '两把一起开。准头不是重点，气势才是。',
  },

  // ───────────── 步枪类 ─────────────
  bulldog: {
    name: '斗牛犬·三连发', short: 'BULLDOG', slot: 1, auto: false,
    dmg: [35, 140, 30], rof: 0.42, mag: 24, reserve: 72, reload: 2.5,
    spread: 0.26, moveMul: 3.0, airMul: 5.4, crouchMul: 0.66,
    falloff: { start: 35, end: 55, mul: 0.86 },
    recoilKick: 1.1, range: 140, burst: 3, burstDelay: 0.07,
    spray: [[0,0],[0,-0.7],[0,-1.3],[0.2,-1.8],[-0.3,-2.2],[0.4,-2.5]],
    model: { len: 0.5, w: 0.062, h: 0.17, col: 0x3d4a3a, barrel: 0.15 },
    flavor: '一次三发。手指扣一下，对面少一截血。',
  },

  // ───────────── 狙击类 ─────────────
  marshal: {
    name: '元帅·轻狙', short: 'MARSHAL', slot: 1, auto: false,
    dmg: [101, 202, 85], rof: 0.75, mag: 5, reserve: 15, reload: 2.5,
    spread: 0.07, moveMul: 9, airMul: 14, crouchMul: 0.85,
    falloff: null,
    recoilKick: 2.0, range: 240, scope: true, scopeFov: 40, scopeSpeed: 0.5,
    spray: [[0,0]],
    model: { len: 0.6, w: 0.05, h: 0.14, col: 0x4a4038, barrel: 0.2, scopeTop: true },
    flavor: '比战地狙轻，打身体不致死，但能连开两枪。',
  },

  // ───────────── 搞笑重武器 ─────────────
  mincer: {
    name: '六管绞肉机', short: 'MINCER', slot: 1, auto: true,
    dmg: [13, 26, 11], rof: 0.042, mag: 180, reserve: 180, reload: 7.5,
    spread: 1.5, moveMul: 1.35, airMul: 2.6, crouchMul: 0.82,
    falloff: { start: 18, end: 42, mul: 0.55 },
    recoilKick: 0.3, range: 90,
    spinUp: 1.05,            // 要先转起来才能打，按住左键会空转
    moveSlow: 0.45,          // 扛着它只能走路速度的 45%
    spray: [[0,0],[0.6,-0.3],[-0.9,-0.5],[1.2,-0.6],[-1.4,-0.7],[1.6,-0.75],
            [-1.8,-0.8],[2.0,-0.82],[-2.1,-0.84],[2.2,-0.85]],
    model: { len: 0.58, w: 0.13, h: 0.22, col: 0x50565e, barrel: 0.3, minigun: true },
    flavor: '预热一秒才开火，扛着它跑不动，散布大得像在泼水。但它有 180 发。',
  },

  // ───────────── 投掷物 ─────────────
  kunai: {
    name: '苦无·飞刀', short: 'KUNAI', slot: 2, auto: false,
    dmg: [65, 220, 50], rof: 0.5, mag: 5, reserve: 10, reload: 2.0,
    spread: 0.1, moveMul: 2.2, airMul: 3, crouchMul: 0.8,
    falloff: null,
    recoilKick: 0.5, range: 120,
    projectile: { speed: 56, gravity: 7.2, radius: 0.13, spin: 22 },
    spray: [[0,0]],
    model: { len: 0.22, w: 0.025, h: 0.07, col: 0x9aa3ad, barrel: 0.0, blade: true },
    flavor: '无声。有下坠，远了要往上瞄。命中头部直接送走。',
  },
};

export const WEAPON_KEYS = Object.keys(WEAPONS);

// 默认携带：主武器 + 副武器
export const LOADOUTS = [
  { name: '突击手',   primary: 'vandal',   secondary: 'classic', d: '一枪爆头，万金油' },
  { name: '控场手',   primary: 'phantom',  secondary: 'classic', d: '射速快，近战稳' },
  { name: '狙击手',   primary: 'operator', secondary: 'sheriff', d: '一枪一个，怕被近身' },
  { name: '轻狙游走', primary: 'marshal',  secondary: 'twins',   d: '能连开两枪，机动高' },
  { name: '突入者',   primary: 'judge',    secondary: 'classic', d: '贴脸之王，远了没用' },
  { name: '游击手',   primary: 'spectre',  secondary: 'kunai',   d: '冲锋枪配飞刀' },
  { name: '点射流',   primary: 'bulldog',  secondary: 'sheriff', d: '三连发，中距离压制' },
  { name: '泼水哥',   primary: 'mincer',   secondary: 'twins',   d: '扛机枪，走得慢打得欢' },
  { name: '忍者',     primary: 'kunai',    secondary: 'classic', d: '纯飞刀，难但很爽' },
];

// ── 伤害计算（含距离衰减）──
export function computeDamage(weapon, part, distance) {
  const idx = part === 'head' ? 1 : part === 'legs' ? 2 : 0;
  let dmg = weapon.dmg[idx];
  if (weapon.falloff && distance > weapon.falloff.start) {
    const f = weapon.falloff;
    const t = Math.min(1, (distance - f.start) / (f.end - f.start));
    dmg *= 1 + (f.mul - 1) * t;
  }
  return Math.round(dmg);
}

// ── 当前散布角（度）──
// 站定 < 下蹲 << 移动 <<< 跳跃
export function computeSpread(weapon, state) {
  let s = weapon.spread;
  if (state.airborne) s *= weapon.airMul;
  else if (state.speed > 1.2) s *= 1 + (weapon.moveMul - 1) * Math.min(1, state.speed / 6);
  else if (state.crouching) s *= weapon.crouchMul;
  return s;
}

// ── 取弹道偏移；超出固定段后转随机 ──
export function sprayOffset(weapon, shotIndex) {
  const p = weapon.spray;
  if (shotIndex < p.length) return p[shotIndex];
  const last = p[p.length - 1];
  return [last[0] + (Math.random() - 0.5) * 2.6, last[1] - Math.random() * 0.3];
}
