// 道路标线：中心线、车道分隔线、边缘线、斑马线、停止线、导向箭头、减速标线、让行线。
//
// 所有标线都是"贴地薄面"，比路面高 0.02 单位，靠高度差避免 z-fighting。
// 宽度按红线宽的比例给（不写死米数）—— 因为这个项目的 1 单位不是 1 米，
// 写死米数会在窄巷里画出一根比路还宽的线。
//
// 规则依据 GB 5768.3（道路交通标线）：
//   · 人行横道只在达到一定交通量 / 宽度的路口设；车行道太窄的支路不设，
//     改在路口前画横向减速标线；
//   · 停止线只画在**来向**半幅，不是整条路宽；
//   · 导向箭头放在进口车道停止线之前，方向按车道功能给；
//   · 支路让干路：进口画让行三角，不画停止线。

import { Pt } from '../core/geom';
import type { SurfaceFeature } from '../scene/types';
import { toCCW } from '../scene/types';
import type { RoadEdge, RoadNet, Junction, RoadClass } from './system';
import { visibleSpan } from './system';
import { specOf, u } from './spec';

const Y_MARK = 0.032;

const W_EDGE = 0.03;
const W_CENTER = 0.028;
const W_LANE = 0.026;

/** 虚线段长 / 间隔（单位）。约等于真实道路的 3 m / 6 m 按当前尺度缩放。
 *
 * 原来是 0.5 / 0.42（段 3.5 m、间 2.9 m），段和间隔差不多长 —— 俯视图上
 * 一排断线读成"斑驳的虚线"，看不出节奏。国标城市道路的车道分界线是
 * 2~4 m 线段配 4~6 m 间隔，比例 1:2 左右；参考图里也是这个比例。
 */
const DASH = 0.43;
const GAP = 0.86;

/** 边上的局部矩形：s 沿线（从 a 起算），d 为横向有符号偏移（左正） */
function strip(e: RoadEdge, s0: number, s1: number, dHi: number, dLo: number): Pt[] | null {
  if (s1 - s0 < 1e-4) return null;
  if (Math.abs(dHi - dLo) < 1e-5) return null;
  const nx = -e.dir.y;
  const ny = e.dir.x;
  const at = (s: number, d: number) =>
    new Pt(e.a.x + e.dir.x * s + nx * d, e.a.y + e.dir.y * s + ny * d);
  return [at(s0, dHi), at(s1, dHi), at(s1, dLo), at(s0, dLo)];
}

/** (s,d) 点列 → 世界坐标 */
function polySD(e: RoadEdge, pts: [number, number][]): Pt[] {
  const nx = -e.dir.y;
  const ny = e.dir.x;
  return pts.map(([s, d]) => new Pt(e.a.x + e.dir.x * s + nx * d, e.a.y + e.dir.y * s + ny * d));
}

function push(out: SurfaceFeature[], e: RoadEdge, name: string, ring: Pt[] | null, mat: 'markWhite' | 'markYellow') {
  if (!ring) return;
  out.push({ name, group: 'road/marking', ring: toCCW(ring), mat, y: Y_MARK });
}

/** 实线 */
function solid(
  out: SurfaceFeature[],
  e: RoadEdge,
  name: string,
  dCenter: number,
  width: number,
  s0: number,
  s1: number,
  mat: 'markWhite' | 'markYellow' = 'markWhite'
) {
  push(out, e, name, strip(e, s0, s1, dCenter + width / 2, dCenter - width / 2), mat);
}

/** 虚线 */
function dashed(
  out: SurfaceFeature[],
  e: RoadEdge,
  name: string,
  dCenter: number,
  width: number,
  s0: number,
  s1: number,
  mat: 'markWhite' | 'markYellow' = 'markWhite',
  dash = DASH,
  gap = GAP
) {
  let s = s0;
  let k = 0;
  while (s < s1 - 1e-3) {
    const e1 = Math.min(s + dash, s1);
    push(out, e, `${name}_${k}`, strip(e, s, e1, dCenter + width / 2, dCenter - width / 2), mat);
    s = e1 + gap;
    k++;
  }
}

/**
 * 导向箭头。sTip = 箭尖位置，dir = +1 表示行进方向为 s 增大。
 * kind:'left'/'right' 只是把箭头偏转 —— 这个尺度下画标准转弯箭头看不出差别，
 * 但箭尖偏向哪边一眼就能读出来。
 */
function arrow(
  out: SurfaceFeature[],
  e: RoadEdge,
  name: string,
  sTip: number,
  dir: number,
  dCenter: number,
  len: number,
  kind: 'straight' | 'left' | 'right'
) {
  const shaftW = len * 0.085;
  const headW = len * 0.26;
  const headL = len * 0.45;
  const back = sTip - dir * len;
  const neck = sTip - dir * headL;
  // 箭尖横向偏移：左右转箭头偏半个头宽，读起来就是"要拐"
  const tipD = kind === 'left' ? dCenter + headW * 0.85 : kind === 'right' ? dCenter - headW * 0.85 : dCenter;
  // 偏转时把箭颈也带一点，避免头变成一个歪三角
  const neckD = kind === 'left' ? dCenter + headW * 0.28 : kind === 'right' ? dCenter - headW * 0.28 : dCenter;
  const ring = polySD(e, [
    [back, dCenter + shaftW],
    [neck, neckD + shaftW * 1.15],
    [neck, neckD + headW],
    [sTip, tipD],
    [neck, neckD - headW],
    [neck, neckD - shaftW * 1.15],
    [back, dCenter - shaftW],
  ]);
  push(out, e, name, ring, 'markWhite');
}

/** 一条细边（(s,d) 空间里的两点）→ 宽度 w 的四边形标线。用于拼菱形轮廓 */
function edgeBar(
  out: SurfaceFeature[],
  e: RoadEdge,
  name: string,
  p0: [number, number],
  p1: [number, number],
  w: number
) {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return;
  const nx = (-dy / L) * (w / 2);
  const ny = (dx / L) * (w / 2);
  push(
    out,
    e,
    name,
    polySD(e, [
      [p0[0] + nx, p0[1] + ny],
      [p1[0] + nx, p1[1] + ny],
      [p1[0] - nx, p1[1] - ny],
      [p0[0] - nx, p0[1] - ny],
    ]),
    'markWhite'
  );
}

/**
 * 人行横道预告标识（国标里的"菱形"）。
 *
 * 参考图上斑马线前有两枚白色菱形，我们之前一枚都没有 —— 于是从空中看，
 * 有斑马线的路口和没斑马线的路口长得一模一样，只能靠远处那条白条纹判断。
 *
 * 按 GB 5768.3：菱形长轴 3 m、短轴 1.5 m、线宽 20 cm，**空心轮廓**
 * （不是实心菱形）。这里用四条细边拼出轮廓 —— 这个尺度下实心菱形会读成
 * "路面上有块白斑"，反而看不出是标记。
 */
function diamond(out: SurfaceFeature[], e: RoadEdge, name: string, sC: number, dC: number, dir: number) {
  const lenS = u(3.2);
  const lenD = u(1.6);
  const w = u(0.2);
  const A: [number, number] = [sC - dir * lenS * 0.5, dC];
  const B: [number, number] = [sC, dC + lenD * 0.5];
  const C: [number, number] = [sC + dir * lenS * 0.5, dC];
  const D: [number, number] = [sC, dC - lenD * 0.5];
  edgeBar(out, e, `${name}_a`, A, B, w);
  edgeBar(out, e, `${name}_b`, B, C, w);
  edgeBar(out, e, `${name}_c`, C, D, w);
  edgeBar(out, e, `${name}_d`, D, A, w);
}

/**
 * 一个路口端的进口标线组。
 *
 * sBase = 该端可见段的起点（a 端为 s0，b 端为 s1），outward = +1 表示往 s 增大方向
 * 布置（a 端），-1 表示往 s 减小方向（b 端）。来向车道在上半幅还是下半幅取决于
 * 车辆行进方向：靠右行驶时，从 a 端驶入路口的车在 d ∈ [mid, carHi]，从 b 端驶入的在
 * d ∈ [carLo, mid]。
 */
function approach(
  out: SurfaceFeature[],
  e: RoadEdge,
  sBase: number,
  outward: number,
  idx: number
) {
  const carLo = -e.carR;
  const carHi = e.carL;
  const width = carHi - carLo;
  if (width < 0.16) return;

  const mid = (carHi + carLo) / 2;
  // 来向半幅（靠右行驶）：从 a 端驶入路口的车在 d ≥ mid，从 b 端驶入的在 d ≤ mid
  const arriveLo = outward > 0 ? mid : carLo;
  const arriveHi = outward > 0 ? carHi : mid;
  const arriveW = arriveHi - arriveLo;

  /** 从路口进口往外量 dist 处的 s。a 端 s 增大是"离开路口"，b 端相反。 */
  const along = (dist: number) => (outward > 0 ? sBase + dist : sBase - dist);
  const inside = (a: number, b: number) => Math.min(a, b) > 0.02 && Math.max(a, b) < e.len - 0.02;

  const spec = specOf(e.cls);
  // 人行横道只按**本路等级**给：支路车行道太窄，横穿不需要画线（GB 5768 只对
  // 达到一定交通量的道路要求人行横道）。支路进干路时改画让行三角 + 减速标线。
  const zebraOk = width >= u(5.6) && spec.crossing;
  // 没有斑马线的窄路口一律按"减速让行"进门：等宽的支路与支路相交也一样。
  // 曾经这里还要求"对向有更宽的路"才算 minor —— 结果两条等宽支路的十字路口
  // 什么标线都没有：没斑马线、没停止线、没让行三角，只剩一个孤零零的箭头，
  // 一眼看去像忘了画。基准规则是无信号路口次要方向让行，等宽时按让右，
  // 四个进口都该有让行标记。
  const minor = !zebraOk;

  const bandLen = Math.min(0.62, Math.max(0.3, width * 0.42));
  const stopW = 0.07;
  let cursor = 0.04;

  if (zebraOk) {
    // 条纹平行于车流，横跨车行道（跨整幅，行人不分行车道）
    const pitch = 0.115;
    const bar = 0.058;
    const z0 = along(cursor);
    const z1 = along(cursor + bandLen);
    if (inside(z0, z1)) {
      let d = carLo;
      let k = 0;
      while (d < carHi - 1e-3) {
        const dHi = Math.min(d + bar, carHi);
        push(out, e, `zebra_${idx}_${k}`, strip(e, Math.min(z0, z1), Math.max(z0, z1), dHi, d), 'markWhite');
        d += pitch;
        k++;
      }
    }
    cursor += bandLen + 0.06;
  }

  // 停止线：只压来向半幅（对向车道的停止线在对面的进口）
  const st0 = along(cursor);
  const st1 = along(cursor + stopW);
  let stopOuter = cursor;
  // 停止线只配斑马线。"停车让行"与"减速让行"不能画在一起 —— 有让行三角就
  // 不再画停止线，否则进口同时出现两道含义冲突的横线。
  if (inside(st0, st1) && zebraOk) {
    push(out, e, `stop_${idx}`, strip(e, Math.min(st0, st1), Math.max(st0, st1), arriveHi, arriveLo), 'markWhite');
    stopOuter = cursor + stopW;
  }
  cursor = stopOuter + 0.06;

  // 让行三角：两排，尖端朝着驶来的车（也就是背离路口的一侧）
  if (minor) {
    const tri = Math.min(0.1, arriveW * 0.18);
    if (tri > 0.045) {
      const cols = Math.max(2, Math.round(arriveW / (tri * 2.2)));
      const step = arriveW / cols;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < cols; c++) {
          const dc = arriveLo + step * (c + 0.5);
          const base = cursor + r * tri * 1.45;
          const ring = polySD(e, [
            [along(base), dc - tri * 0.55],
            [along(base + tri), dc],
            [along(base), dc + tri * 0.55],
          ]);
          push(out, e, `yield_${idx}_${r}_${c}`, ring, 'markWhite');
        }
      }
      cursor += tri * 2.6;
    }
  }

  // 横向减速标线：支路进干路、但本路不设斑马线时，在让行线外再补三道
  if (minor) {
    // 5 道细线、间距 0.6 m：3 道粗线在白底路面上会被读成"斑马线"，
    // 而这里要表达的是"减速带前预告"，得是密的细条。
    const barW = 0.022;
    const pitch = 0.09;
    for (let k = 0; k < 5; k++) {
      const off = cursor + k * pitch;
      const a0 = along(off);
      const a1 = along(off + barW);
      if (!inside(a0, a1)) continue;
      push(out, e, `slow_${idx}_${k}`, strip(e, Math.min(a0, a1), Math.max(a0, a1), arriveHi, arriveLo), 'markWhite');
    }
    cursor += 4 * pitch + barW + 0.1;
  }

  // 导向箭头：进口车道逐条画，箭尖顶在最后一道标线之外
  cursor = Math.max(cursor, stopOuter + 0.05);
  if (arriveW < 0.34) return;
  const lanes = Math.max(1, Math.round(arriveW / Math.max(e.laneWidth, 0.16)));
  const laneW = arriveW / lanes;
  const alen = Math.min(0.52, Math.max(0.24, laneW * 1.55));
  const tipD = cursor;
  if (along(tipD + alen) < 0.04 || along(tipD + alen) > e.len - 0.04) return;
  const tip = along(tipD);
  for (let k = 0; k < lanes; k++) {
    const dc = arriveLo + laneW * (k + 0.5);
    const kind: 'straight' | 'left' | 'right' =
      lanes >= 3 && k === 0 ? 'left' : lanes >= 3 && k === lanes - 1 ? 'right' : 'straight';
    arrow(out, e, `arrow_${idx}_${k}`, tip, -outward, dc, alen, kind);
  }

  // 人行横道预告菱形：放在整组标线的最外侧（离路口最远），每个车道一枚。
  // 只给有斑马线的进口 —— 国标里它就是"前面有人行横道"的预告，
  // 没斑马线的进口配菱形是自相矛盾。
  if (zebraOk) {
    const sD = along(tipD + alen + u(2.6));
    if (sD > 0.04 && sD < e.len - 0.04) {
      for (let k = 0; k < lanes; k++) {
        const dc = arriveLo + laneW * (k + 0.5);
        diamond(out, e, `diamond_${idx}_${k}`, sD, dc, -outward);
      }
    }
  }
}

function junctionOf(net: RoadNet, p: Pt): Junction | undefined {
  // 合并路口里一个路口吃掉多个顶点，端点不再等于路口中心 —— 必须查映射
  const i = net.nodeJunction.get(p);
  return i === undefined ? undefined : net.junctions[i];
}

export function roadMarkings(net: RoadNet, out: SurfaceFeature[]): void {
  net.edges.forEach((e, i) => {
    if (e.len < 1e-6) return;
    if (e.padA + e.padB >= e.len * 0.995) return;
    const [t0, t1] = visibleSpan(e);
    const s0 = t0 * e.len;
    const s1 = t1 * e.len;
    if (s1 - s0 < 0.12) return;

    const carLo = -e.carR;
    const carHi = e.carL;
    const mid = (carHi + carLo) / 2;

    // 边缘线（实白），贴着车行道两侧
    const inset = Math.min(W_EDGE * 0.9, (carHi - carLo) * 0.12);
    solid(out, e, `edge_L_${i}`, carHi - inset - W_EDGE / 2, W_EDGE, s0 + 0.02, s1 - 0.02);
    solid(out, e, `edge_R_${i}`, carLo + inset + W_EDGE / 2, W_EDGE, s0 + 0.02, s1 - 0.02);

    if (e.standalone) {
      // 城外引道只有边线
    } else if (e.lanes >= 4) {
      // 四车道及以上：双黄中心线 + 同向车道分隔虚线。
      // 按**车道数**判，不再按等级判 —— 断面改成"两/四/六车道"之后，
      // 四车道的次干路占了大头，按等级判会让它们只有一条中线，
      // 14 m 的车行道看起来像"两车道画歪了"。
      const sep = W_CENTER * 0.85;
      solid(out, e, `center_L_${i}`, mid + sep, W_CENTER, s0 + 0.02, s1 - 0.02, 'markYellow');
      solid(out, e, `center_R_${i}`, mid - sep, W_CENTER, s0 + 0.02, s1 - 0.02, 'markYellow');

      const half = Math.floor(e.lanes / 2);
      for (let k = 1; k < half; k++) {
        const d = mid + k * e.laneWidth;
        dashed(out, e, `laneR_${i}_${k}`, d, W_LANE, s0 + 0.5, s1 - 0.9);
        dashed(out, e, `laneL_${i}_${k}`, mid - k * e.laneWidth, W_LANE, s0 + 0.5, s1 - 0.9);
      }
    } else if (e.lanes >= 2) {
      // 两车道：单黄虚线中心线（可借道超车，所以是虚线不是实线）
      dashed(out, e, `center_${i}`, mid, W_CENTER, s0 + 0.5, s1 - 0.9, 'markYellow');
    }

    // 路段节奏箭头。
    //
    // 原来箭头只画在路口进口（`approach`），一条 200 m 的主干道中段是一片空白 ——
    // 从空中看不知道这条路是单行还是双向。参考 site-studio 的做法：
    // 箭头不是"画在设计位置"，而是**按节奏走中心线**（`marking.arrows`）：
    //   间距 30 m、起算 12 m、长 5 m、杆宽 0.4 m、箭头长 1.7 m 宽 1.15 m；
    //   每个行车方向一条，车道中心取 `车道宽/4` 的横向偏移。
    // 这里只把它落到本项目的单位制上（1 单位 = 7 m），间距规则不变。
    if (!e.standalone && e.lanes >= 2) {
      const ARROW_SPACING = u(30);
      const ARROW_LEN = u(5);
      // 车道中心：车行道宽度 / 4，左右两个方向各一条
      const laneOff = (carHi - carLo) / 4;
      // 端头各留 1.0 单位（≈7 m）给路口标线组，避免箭头顶在停止线上
      const lo = s0 + 1.0;
      const hi = s1 - 1.0;
      const span = hi - lo;
      // 边够长就按 30 m 的节奏走；这个城市的路口密，多数边只有 20 m 左右，
      // 排不下一个周期 —— 那就退化成"中段放一个方向箭头"，
      // 好歹让这条路读得出是双向的（原来一条都没有）。
      const tips: number[] = [];
      if (span >= ARROW_SPACING) {
        for (let s = lo + ARROW_SPACING * 0.4; s <= hi; s += ARROW_SPACING) tips.push(s);
      } else if (span >= ARROW_LEN * 2.2) {
        tips.push((lo + hi) / 2);
      }
      for (let k = 0; k < tips.length; k++) {
        for (const sign of [1, -1]) {
          const dc = mid + sign * laneOff;
          // 箭头必须整个落在车行道里，否则会啃到人行道
          if (dc + ARROW_LEN * 0.13 > carHi || dc - ARROW_LEN * 0.13 < carLo) continue;
          arrow(out, e, `flow_${i}_${k}_${sign > 0 ? 'p' : 'n'}`, tips[k], sign, dc, ARROW_LEN, 'straight');
        }
      }
    }

    // 路口端：进口标线组。
    // 整段都落在路口里的短边（shortA/shortB）不画 —— 它的"进口"就在路口中间，
    // 画上去会变成路口里一根孤零零的白杠。
    if (!e.standalone && s1 - s0 > 0.55) {
      const ja = junctionOf(net, e.a);
      const jb = junctionOf(net, e.b);
      if (ja && ja.arms.length >= 3 && !e.shortA) approach(out, e, s0, 1, i * 2);
      if (jb && jb.arms.length >= 3 && !e.shortB) approach(out, e, s1, -1, i * 2 + 1);
    }
  });
}

/** 停车场车位线：一块铺装里按行列画车位分隔线 */
export function parkingStalls(
  out: SurfaceFeature[],
  origin: Pt,
  dirX: Pt,
  dirY: Pt,
  cols: number,
  rows: number,
  stallW: number,
  stallL: number,
  namePrefix: string,
  mat: 'markWhite' | 'markYellow' = 'markWhite'
): void {
  const Y = 0.031;
  const lw = 0.022;
  const at = (u: number, v: number) => new Pt(origin.x + dirX.x * u + dirY.x * v, origin.y + dirX.y * u + dirY.y * v);

  const totalW = cols * stallW;
  const totalL = rows * stallL;

  // 横向分隔线（每条车位边界一条）
  for (let c = 0; c <= cols; c++) {
    const u = c * stallW;
    const r = [at(u - lw / 2, 0), at(u + lw / 2, 0), at(u + lw / 2, totalL), at(u - lw / 2, totalL)];
    out.push({ name: `${namePrefix}_vs_${c}`, group: 'parking/marking', ring: toCCW(r), mat, y: Y });
  }
  // 纵向端线
  for (const v of [0, totalL]) {
    const r = [at(-lw / 2, v - lw / 2), at(totalW + lw / 2, v - lw / 2), at(totalW + lw / 2, v + lw / 2), at(-lw / 2, v + lw / 2)];
    out.push({ name: `${namePrefix}_hs_${v}`, group: 'parking/marking', ring: toCCW(r), mat, y: Y });
  }
}
