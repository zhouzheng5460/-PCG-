// 禁区"势流绕障"偏转（ZoneDeflector）。
//
// 要的效果（用户手绘参考图）
// --------------------------
// 把禁区当成河里的一块石头：流线过来、分开、贴着它绕过去、再合回去。
// **没有一圈贴着禁区的环路**，也不能在禁区边上断头，各条街之间还要保持间距。
//
// 为什么前面几种做法都不行（都是实测过的，别再走回头路）
// ------------------------------------------------------
// · 把禁区边延长成方向源（旧）：街道被掰成与禁区平行、一路铺到红线上 ——
//   用户说的"路硬怼在禁区上"。
// · 切向 path 源（顺着轮廓弯）：长边的切向和全局主朝向同向，场没有转的动力；
//   短边的切向又与主朝向垂直，2θ 空间里两者反向抵消 —— 结果是方向翻 90°，
//   要么不转弯，要么直接拐死弯。
// · 剪掉进禁区的段（几何后处理）：禁区里确实没路了，但四周变成一片
//   没有路的荒地，每条街都断在禁区边上。
// · 逐点位移 / 绕行弧：位移场必然折叠（把平面的一个洞摊平需要撕裂），
//   折叠就出现针尖碎面、楼骑在车行道上；绕行弧会让多条街塌到同一条曲线上。
//
// 为什么是偶极子
// --------------
// 二维不可压缩流动绕一个圆柱，速度场有闭式解：
//   u = Ux − (Ux(X²−Y²) + 2Uy·XY)/r⁴
//   v = Uy + (Uy(X²−Y²) − 2Ux·XY)/r⁴        （柱半径归一化成 1）
// 它有三个正是我们要的性质：
//   · **无散度**：流线永远不会交叉、也不会并到一条线上 —— 间距自动保持；
//   · **双射**：柱外的每一点都有唯一去处，于是不会撕裂出碎面；
//   · 驻点：正对柱心的那一条流线在柱前停住、分成两股，就是参考图里
//     "水在石头前面分开"的样子。
// 把"圆柱"换成"椭圆"只要在禁区自身坐标系里把 x/y 各除半轴长（下面 scale 那步），
// 于是 26×12.8 这种长条形禁区不会被当成半径 13 的大圆去绕。
//
// 注意：这里偏转的是**方向**，即给张量场算出来的单位方向叠一个扰动向量。
// 场本身没变（不去改 field 的场源），所以远处肌理、等级分配、街区统计全都不受影响。

import { Pt } from '../../core/geom';

interface ZoneShape {
  /** 禁区中心 */
  cx: number;
  cy: number;
  /** 局部坐标系旋转角（长轴方向） */
  ang: number;
  /** 让距后的半轴长（世界单位，已含 pad） */
  rx: number;
  ry: number;
}

function ringContains(ring: Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * 禁区形状 → 等价的"椭圆柱"。
 *
 * 长轴方向用 4θ 加权的圆平均（θ 与 θ+90° 视为同一方向，于是一条矩形的四条边
 * 会全部叠到同一个角度上而不是两两抵消）；半轴长取局部包围盒，长轴配长边。
 * 对圆、椭圆、随手画的团，这套退化成"外接椭圆"，绕障照样成立。
 */
function shapeOf(ring: Pt[], pad: number): ZoneShape | null {
  if (ring.length < 3) return null;
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
  }
  cx /= ring.length;
  cy /= ring.length;

  let sc = 0;
  let ss = 0;
  let tw = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const t = Math.atan2(dy, dx) * 4;
    sc += Math.cos(t) * L;
    ss += Math.sin(t) * L;
    tw += L;
  }
  const ang = tw > 1e-6 ? 0.25 * Math.atan2(ss, sc) : 0;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);

  let mx = 0;
  let my = 0;
  for (const p of ring) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    mx = Math.max(mx, Math.abs(dx * ca + dy * sa));
    my = Math.max(my, Math.abs(-dx * sa + dy * ca));
  }
  // 长轴配长边：4θ 平均可能把 ang 定在短边方向上（矩形两条边相差 90°，
  // 数值上两种都可能落出来），这里按包围盒把 rx/ry 摆正，避免把长条禁区
  // 当成"竖直的窄椭圆"去绕。
  let rx = mx + pad;
  let ry = my + pad;
  let theta = ang;
  if (ry > rx) {
    const t = rx;
    rx = ry;
    ry = t;
    theta = ang + Math.PI / 2;
  }
  const minHalf = Math.max(1e-3, Math.min(rx, ry) * 0.35);
  return { cx, cy, ang: theta, rx: Math.max(rx, minHalf), ry: Math.max(ry, minHalf) };
}

export class ZoneDeflector {
  private shapes: ZoneShape[] = [];
  private rings: Pt[][];
  private pad: number;

  constructor(rings: Pt[][], pad: number) {
    this.rings = rings.filter((r) => r.length >= 3);
    this.pad = Math.max(0, pad);
    for (const r of this.rings) {
      const s = shapeOf(r, this.pad);
      if (s) this.shapes.push(s);
    }
  }

  get empty(): boolean {
    return this.shapes.length === 0;
  }

  /**
   * 点是否落在禁区里（不含让距）。
   *
   * 不用 |Q|<1 判定：那是等价椭圆，长条禁区两端会比真轮廓胖出一截，
   * 拿它当"禁区"会把正常街道误判进去。精确判定一律走真实轮廓。
   */
  inside(x: number, y: number): boolean {
    for (const r of this.rings) if (ringContains(r, x, y)) return true;
    return false;
  }

  /**
   * 给一个方向叠上绕障扰动。
   *
   * dir 必须是单位向量；返回也是单位向量。落在禁区内部时原样返回
   * （那里本来就要被剪掉，掰弯它只会让剪口歪）。
   */
  apply(x: number, y: number, dir: Pt): Pt {
    let vx = dir.x;
    let vy = dir.y;
    for (const s of this.shapes) {
      const c = Math.cos(s.ang);
      const sn = Math.sin(s.ang);
      const dx = x - s.cx;
      const dy = y - s.cy;
      // 世界 → 禁区局部（local = Rᵀ·world）
      const lx = c * dx + sn * dy;
      const ly = -sn * dx + c * dy;
      // 局部 → 单位圆空间（各除半轴）
      const X = lx / s.rx;
      const Y = ly / s.ry;
      const r2 = X * X + Y * Y;
      // 圆内不做（那里本来就要被剪掉），太远不做（扰动已 <1%）
      if (r2 <= 1.0001 || r2 > 400) continue;

      // 方向也做同一个线性映射：圆空间 = 局部 / 半轴
      const ux0 = c * vx + sn * vy;
      const uy0 = -sn * vx + c * vy;
      const wx = ux0 / s.rx;
      const wy = uy0 / s.ry;

      // 绕单位圆柱的势流解（无散度 ⇒ 流线不交叉、不合并）
      const r4 = r2 * r2;
      const A = (X * X - Y * Y) / r4;
      const B = (2 * X * Y) / r4;
      const cx2 = wx - (wx * A + wy * B);
      const cy2 = wy + (wy * A - wx * B);

      // 圆空间 → 局部 → 世界
      const nx = cx2 * s.rx;
      const ny = cy2 * s.ry;
      vx = c * nx - sn * ny;
      vy = sn * nx + c * ny;
    }
    const L = Math.hypot(vx, vy);
    if (L < 1e-9) return dir;
    return new Pt(vx / L, vy / L);
  }
}
