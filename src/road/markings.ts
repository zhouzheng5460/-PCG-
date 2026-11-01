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
 *
 * 尺寸口径（本轮按用户意见改）：**宽度跟着车道宽走，而不是跟着箭长走**。
 * 原来杆宽 / 头宽都是 `len` 的定比（0.085 / 0.26），于是一条 7 m 窄路上的
 * 5 m 长箭头会得到 1.8 m 宽的头 —— 车道上几乎摆满，读起来像一块白斑。
 * 现在头宽封在车道的 46% 以内，杆宽封在 13% 以内；`len` 再由调用方按
 * 路宽 / 车道宽算，窄路短、宽路长。
 */
function arrow(
  out: SurfaceFeature[],
  e: RoadEdge,
  name: string,
  sTip: number,
  dir: number,
  dCenter: number,
  len: number,
  kind: 'straight' | 'left' | 'right',
  laneW: number
) {
  const lw = Math.max(laneW, 0.1);
  const shaftW = Math.min(len * 0.085, lw * 0.13);
  const headW = Math.min(len * 0.26, lw * 0.46);
  const headL = Math.min(len * 0.45, lw * 0.62);
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
 * 一个路口端的进口标线组在**纵向上占用的长度**（从可见段端点往路内量）。
 *
 * 为什么需要它：进口标线组（斑马线 + 停止线 + 让行三角 + 减速标线 + 箭头 + 菱形）
 * 是按"从端点往外排"算出来的，而纵向标线（边缘线 / 中心线 / 车道分隔线）走的是
 * 另一条独立的口径 —— 从 `s0 + 0.02` 一路画到 `s1 - 0.02`。两套口径互不知道对方，
 * 结果就是**双黄线从斑马线正中穿过去、边缘线压着停止线**（用户截图里红圈那两处）：
 * 同一处地面叠着两层漆，既互相盖压（同标高 z-fighting，俯视图上会闪），
 * 也不符合 GB 5768.3 —— 路口进口范围内的纵向标线在人行横道/停止线之前中断。
 *
 * 所以把它抽成一个两处共用的判据：`approach()` 用它决定标线组的排布起点，
 * `roadMarkings()` 用它决定纵向线该在哪里收头。
 */
interface ApproachSpan {
  /** 这一端是否画整组进口标线（有斑马线才画） */
  zebra: boolean;
  /** 纵向标线必须让开的长度（含停止线外沿 + 一点点留白） */
  clear: number;
  /** 纵向标线在该端的横向可用区间（让开边缘线与中心线本身） */
  dLo: number;
  dHi: number;
}

/** 斑马线带宽：跟着车行道宽度走，0.3~0.62（约 2~4.3 m） */
function zebraBandLen(width: number): number {
  return Math.min(0.62, Math.max(0.3, width * 0.42));
}

function approachSpan(e: RoadEdge, outward: number): ApproachSpan {
  const carLo = -e.carR;
  const carHi = e.carL;
  const width = carHi - carLo;
  const mid = (carHi + carLo) / 2;
  const arriveLo = outward > 0 ? mid : carLo;
  const arriveHi = outward > 0 ? carHi : mid;
  // 来向半幅的横向可用区间：把边缘线与中心线本身的宽度让出去。
  // 停止线 / 让行三角 / 减速标线都排在这里面 —— 原来直接用 arriveLo..arriveHi，
  // 停止线的两端各压住一条纵向线（0.03 宽，约 21 cm，俯视图上是一条白杠叠白杠）。
  const inset = Math.min(W_EDGE * 0.9, width * 0.12);
  const innerPad = e.lanes >= 4 ? W_CENTER * 0.85 + W_CENTER / 2 : W_CENTER / 2;
  const outerPad = inset + W_EDGE;
  const dLo = outward > 0 ? arriveLo + innerPad : arriveLo + outerPad;
  const dHi = outward > 0 ? arriveHi - outerPad : arriveHi - innerPad;

  if (width < 0.16) return { zebra: false, clear: 0, dLo, dHi };
  const spec = specOf(e.cls);
  const zebra = width >= u(5.6) && spec.crossing;
  if (!zebra) return { zebra: false, clear: 0, dLo, dHi };
  // 斑马线 [0.04, 0.04+bandLen] → 留 0.06 → 停止线 0.07
  const stopOuter = 0.04 + zebraBandLen(width) + 0.06 + 0.07;
  return { zebra: true, clear: stopOuter + 0.03, dLo, dHi };
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
  // 与纵向标线共用的横向口径：停止线 / 让行三角 / 减速标线只排在
  // "边缘线与中心线之间"，不再各自去压那两条线（详见 approachSpan 的注释）
  const span = approachSpan(e, outward);
  const stopLo = Math.min(span.dLo, span.dHi);
  const stopHi = Math.max(span.dLo, span.dHi);

  /** 从路口进口往外量 dist 处的 s。a 端 s 增大是"离开路口"，b 端相反。 */
  const along = (dist: number) => (outward > 0 ? sBase + dist : sBase - dist);
  const inside = (a: number, b: number) => Math.min(a, b) > 0.02 && Math.max(a, b) < e.len - 0.02;

  const spec = specOf(e.cls);
  // 人行横道只按**本路等级**给：支路车行道太窄，横穿不需要画线（GB 5768 只对
  // 达到一定交通量的道路要求人行横道）。支路进干路时改画让行三角 + 减速标线。
  const zebraOk = span.zebra;
  // 没有斑马线的窄路口一律按"减速让行"进门：等宽的支路与支路相交也一样。
  // 曾经这里还要求"对向有更宽的路"才算 minor —— 结果两条等宽支路的十字路口
  // 什么标线都没有：没斑马线、没停止线、没让行三角，只剩一个孤零零的箭头，
  // 一眼看去像忘了画。基准规则是无信号路口次要方向让行，等宽时按让右，
  // 四个进口都该有让行标记。
  const minor = !zebraOk;

  const bandLen = zebraBandLen(width);
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
    push(out, e, `stop_${idx}`, strip(e, Math.min(st0, st1), Math.max(st0, st1), stopHi, stopLo), 'markWhite');
    stopOuter = cursor + stopW;
  }
  cursor = stopOuter + 0.06;

  // 让行三角：两排，尖端朝着驶来的车（也就是背离路口的一侧）
  if (minor) {
    const tri = Math.min(0.1, arriveW * 0.18);
    const spanW = Math.max(0, stopHi - stopLo);
    if (tri > 0.045 && spanW > tri * 2) {
      const cols = Math.max(2, Math.round(spanW / (tri * 2.2)));
      const step = spanW / cols;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < cols; c++) {
          const dc = stopLo + step * (c + 0.5);
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
      push(out, e, `slow_${idx}_${k}`, strip(e, Math.min(a0, a1), Math.max(a0, a1), stopHi, stopLo), 'markWhite');
    }
    cursor += 4 * pitch + barW + 0.1;
  }

  // 导向箭头：进口车道逐条画，箭尖顶在最后一道标线之外
  cursor = Math.max(cursor, stopOuter + 0.05);
  if (arriveW < 0.34) return;
  const lanes = Math.max(1, Math.round(arriveW / Math.max(e.laneWidth, 0.16)));
  const laneW = arriveW / lanes;
  // 箭长按**车道宽**给（≈3 m 起、封顶 3.6 m），窄车道自动变短
  const alen = Math.min(u(3.6), Math.max(u(2.2), laneW * 1.15));
  const tipD = cursor;
  if (along(tipD + alen) < 0.04 || along(tipD + alen) > e.len - 0.04) return;
  const tip = along(tipD);
  for (let k = 0; k < lanes; k++) {
    const dc = arriveLo + laneW * (k + 0.5);
    const kind: 'straight' | 'left' | 'right' =
      lanes >= 3 && k === 0 ? 'left' : lanes >= 3 && k === lanes - 1 ? 'right' : 'straight';
    arrow(out, e, `arrow_${idx}_${k}`, tip, -outward, dc, alen, kind, laneW);
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

/** 一条边在折点 V 那一端的标线端点：沿线的 s + 该端的横向单位法线 */
interface MarkEnd {
  s: number;
  n: Pt;
  at: (d: number) => Pt;
}

function markEnd(e: RoadEdge, V: Pt): MarkEnd {
  const atB = Pt.distance(e.b, V) <= Pt.distance(e.a, V);
  const n = new Pt(-e.dir.y, e.dir.x);
  const [t0, t1] = visibleSpan(e);
  const s = atB ? t1 * e.len : t0 * e.len;
  const at = (d: number) => new Pt(e.a.x + e.dir.x * s + n.x * d, e.a.y + e.dir.y * s + n.y * d);
  return { s, n, at };
}

/**
 * 折点处的标线补口。
 *
 * 用户核对意见（图 3）："道路弯曲位置的模型断裂" —— 放大看，真正断的不是路面，
 * 而是**标线**：双黄线在折点两侧各收各的头（各收 0.02），中间留一道几十厘米的
 * 缺口；更明显的是**错位** —— 两条边的断面宽度不同，`mid = (carL - carR)/2`
 * 算出来的中心线横向位置就不一样，接起来是一截斜着错开的黄线。
 * 边缘线同理，只是颜色浅、不容易被注意到。
 *
 * 所以补的方式是"把两条边的标线端点用一块梯形连起来"：
 *   · 端点位置取 `visibleSpan` 的真实端点（含 0.02 的收缩），缺口正好被盖住；
 *   · 梯形两侧用**各自的端面法线**扩展半个线宽，宽度不同的边也能接得顺；
 *   · 左右配对按"两条边在 V 处的左法线是否同向"决定 —— 反向时左右交叉，
 *     否则补出来的面会扭成一个 8 字形。
 */
function bendMarkings(net: RoadNet, out: SurfaceFeature[]): void {
  let seq = 0;
  for (const [V, list] of net.nodeEdges) {
    if (list.length !== 2) continue;
    if (net.nodeJunction.has(V)) continue;
    const e1 = net.edges[list[0]];
    const e2 = net.edges[list[1]];
    if (!e1 || !e2 || e1 === e2) continue;
    if (e1.standalone || e2.standalone) continue;
    // 只有带中心线的路才补：单行支路本来就只有边缘线
    if (e1.lanes < 2 || e2.lanes < 2) continue;

    // ---- 这里补的是"折点"，不是"路口里的小节点"
    //
    // 错位路口合并（`MERGE_LEN`）之后，被合并掉的那两个顶点之间还留着一条
    // 很短的连接边：它在 nodeEdges 里是**度数 2 的节点**，而且不是
    // `nodeJunction` 的 key —— 只看这两条判据，它就是"折点"，于是被补上一块
    // 梯形。可这条边的 padA/padB 已经把整段让给了路口（可见段为 0），
    // 两条线的"端点"实际上落在路口铺装里面：补出来的就是**从路口中心横穿
    // 出去的一截黄线 / 白线**（用户截图④里路口中央那两道悬空标线）。
    //
    // 判据分两层，任意一条命中就不补：
    //   ① 这一端本身已经被路口收口（padAt > 0）—— 折点端一定 pad = 0；
    //   ② 两条边里有一条没有实体（可见段 < 0.2），它只是路口内部的连接边。
    const padAt = (e: RoadEdge, P: Pt) => (e.a === P ? e.padA : e.padB);
    if (padAt(e1, V) > 1e-6 || padAt(e2, V) > 1e-6) continue;
    if (e1.len - e1.padA - e1.padB < 0.2 || e2.len - e2.padA - e2.padB < 0.2) continue;

    const f1 = markEnd(e1, V);
    const f2 = markEnd(e2, V);
    const same = f1.n.x * f2.n.x + f1.n.y * f2.n.y > 0;

    const link = (d1: number, d2: number, w: number, mat: 'markWhite' | 'markYellow', tag: string) => {
      const p1 = f1.at(d1);
      const p2 = f2.at(d2);
      if (Pt.distance(p1, p2) < 0.004) return; // 本来就连着，不用补
      // 兜底闸：折点的两个端头相距必然在一个线宽量级（≈0.1 u）。
      // 拉开到 0.35 u 以上的，说明这两个端点分属路口两侧的直路段 ——
      // 那不是折点，是一处路口，补上去就是横穿路口的一条线。
      if (Pt.distance(p1, p2) > 0.35) return;
      const a1 = new Pt(p1.x + f1.n.x * (w / 2), p1.y + f1.n.y * (w / 2));
      const b1 = new Pt(p1.x - f1.n.x * (w / 2), p1.y - f1.n.y * (w / 2));
      const a2 = new Pt(p2.x + f2.n.x * (w / 2), p2.y + f2.n.y * (w / 2));
      const b2 = new Pt(p2.x - f2.n.x * (w / 2), p2.y - f2.n.y * (w / 2));
      const ring = same ? [a1, a2, b2, b1] : [a1, b2, a2, b1];
      out.push({
        name: `bendmark_${seq++}_${tag}`,
        group: 'road/marking',
        ring: toCCW(ring),
        mat,
        // 比主线低 0.002（≈1.4 cm，肉眼看不出来）：补口的梯形**必然**和两条边
        // 自己的线端头有一小块重叠（两块矩形在折角处相交就是一个 w² 的楔形），
        // 同标高白漆叠白漆会 z-fighting —— 俯视图上那一小块会闪成灰斑。
        // 压低一层之后"谁在上面"是确定的：线永远盖住补口。
        y: Y_MARK - 0.002,
      });
    };

    // 边缘线：贴着车行道两侧，左右各自配对
    const inset1 = Math.min(W_EDGE * 0.9, (e1.carL + e1.carR) * 0.12);
    const inset2 = Math.min(W_EDGE * 0.9, (e2.carL + e2.carR) * 0.12);
    const dL1 = e1.carL - inset1 - W_EDGE / 2;
    const dR1 = -e1.carR + inset1 + W_EDGE / 2;
    const dL2 = e2.carL - inset2 - W_EDGE / 2;
    const dR2 = -e2.carR + inset2 + W_EDGE / 2;
    if (same) {
      link(dL1, dL2, W_EDGE, 'markWhite', 'L');
      link(dR1, dR2, W_EDGE, 'markWhite', 'R');
    } else {
      link(dL1, dR2, W_EDGE, 'markWhite', 'L');
      link(dR1, dL2, W_EDGE, 'markWhite', 'R');
    }

    // 中心线：四车道是双黄，两车道是单黄
    const m1 = (e1.carL - e1.carR) / 2;
    const m2 = (e2.carL - e2.carR) / 2;
    const sep = W_CENTER * 0.85;
    const dbl = e1.lanes >= 4 || e2.lanes >= 4;
    if (dbl) {
      link(m1 + sep, same ? m2 + sep : m2 - sep, W_CENTER, 'markYellow', 'c1');
      link(m1 - sep, same ? m2 - sep : m2 + sep, W_CENTER, 'markYellow', 'c2');
    } else {
      link(m1, m2, W_CENTER, 'markYellow', 'c');
    }
  }
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
    // 端头留白：**只在有路口的那一端**留 0.02（那是让开路口铺装）。
    // 折点（两条边直接相接、没有路口）那一端几乎不留 —— 留下一道 0.02 的
    // 空白，和 bendMarkings 补的梯形之间就差出半条可视缝，用户看到的就是
    // "弯道处标线断开"。
    const ja = junctionOf(net, e.a);
    const jb = junctionOf(net, e.b);
    const gapA = ja ? 0.02 : 0.001;
    const gapB = jb ? 0.02 : 0.001;

    // 这一端到底画不画整组进口标线 —— 判据必须和下面 ⑤ 的那两行完全一致，
    // 否则会出现"标线组画了，纵向线却不知道该让"的情况（就是用户截图里的红圈）。
    const wantA = !!ja && ja.arms.length >= 3 && !e.shortA;
    const wantB = !!jb && jb.arms.length >= 3 && !e.shortB;
    const spanA = wantA ? approachSpan(e, 1) : null;
    const spanB = wantB ? approachSpan(e, -1) : null;

    // 两端都要画时，两组不能互相压盖：两组的长度之和必须装得进可见段。
    //
    // 这一条是"斑马线压斑马线"的根因。两条路口之间的短连接段（实测有一条
    // 3 u 长、两端各被路口收掉 0.8，可见段只剩 1.36）两端各画一整组，每组
    // 0.82 长 —— 加起来 1.64 > 1.36：于是 A 端的斑马线压住 B 端的停止线和
    // 箭头，B 端的斑马线又压住 A 端的停止线，交叉处叠出几道灰线
    // （同标高的白漆互相 z-fighting，俯视图上就是"横线穿过斑马线"）。
    // 这种短边本来就容不下一整套进口标线，两组都不画比画两套叠在一起干净。
    const needLen = (spanA ? spanA.clear : 0) + (spanB ? spanB.clear : 0);
    const fits = needLen + 0.12 <= s1 - s0;
    const drawA = !!spanA && fits;
    const drawB = !!spanB && fits;

    // 纵向标线的实际起止：两端各自让开自己的进口标线组（斑马线 + 停止线）。
    //
    // 这是本轮修的**主要问题**：原来纵向线一律从 `s0 + 0.02` 画到 `s1 - 0.02`，
    // 而斑马线正好落在 `[s0+0.04, s0+0.04+bandLen]` —— 于是双黄线、边缘线、
    // 车道分隔线全都**纵穿斑马线**，还压过停止线。GB 5768.3 里路口进口的纵向
    // 标线是在停止线（人行横道之前）中断的，不是"穿过路口再收头"。
    const la = s0 + gapA + (drawA ? spanA!.clear : 0);
    const lb = s1 - gapB - (drawB ? spanB!.clear : 0);
    const hasLong = lb - la > 0.08;

    // 边缘线（实白），贴着车行道两侧
    const inset = Math.min(W_EDGE * 0.9, (carHi - carLo) * 0.12);
    if (hasLong) {
      solid(out, e, `edge_L_${i}`, carHi - inset - W_EDGE / 2, W_EDGE, la, lb);
      solid(out, e, `edge_R_${i}`, carLo + inset + W_EDGE / 2, W_EDGE, la, lb);
    }

    if (e.standalone) {
      // 城外引道只有边线
    } else if (!hasLong) {
      // 两端进口标线组把整条边吃掉了（两条路口之间的极短连接段）：
      // 这一小段只在路口里，不该有纵向线
    } else if (e.lanes >= 4) {
      // 四车道及以上：双黄中心线 + 同向车道分隔虚线。
      // 按**车道数**判，不再按等级判 —— 断面改成"两/四/六车道"之后，
      // 四车道的次干路占了大头，按等级判会让它们只有一条中线，
      // 14 m 的车行道看起来像"两车道画歪了"。
      const sep = W_CENTER * 0.85;
      solid(out, e, `center_L_${i}`, mid + sep, W_CENTER, la, lb, 'markYellow');
      solid(out, e, `center_R_${i}`, mid - sep, W_CENTER, la, lb, 'markYellow');

      const half = Math.floor(e.lanes / 2);
      for (let k = 1; k < half; k++) {
        const d = mid + k * e.laneWidth;
        dashed(out, e, `laneR_${i}_${k}`, d, W_LANE, la + 0.02, lb - 0.02);
        dashed(out, e, `laneL_${i}_${k}`, mid - k * e.laneWidth, W_LANE, la + 0.02, lb - 0.02);
      }
    } else if (e.lanes >= 2) {
      // 两车道：单黄虚线中心线（可借道超车，所以是虚线不是实线）
      dashed(out, e, `center_${i}`, mid, W_CENTER, la + 0.02, lb - 0.02, 'markYellow');
    }

    // 路段节奏箭头。
    //
    // 原来箭头只画在路口进口（`approach`），一条 200 m 的主干道中段是一片空白 ——
    // 从空中看不知道这条路是单行还是双向。参考 site-studio 的做法：
    // 箭头不是"画在设计位置"，而是**按节奏走中心线**（`marking.arrows`）。
    //
    // 本轮按用户意见收了两处（图 2 "箭头数量有点多、大小要按路宽调"）：
    //   · **数量**：间距 30 m → 50 m，两端让开 20 m 给进口标线组。这个城市
    //     的路口密，街区边长多在 20~40 m，改完之后这些短边**不再额外撒箭头**，
    //     进口那一组（每车道一枚）就够读了；只有真正长的路段才有中段节奏。
    //   · **大小**：箭长按车行道宽度给（车宽的 0.55 倍，2.6~4.6 m），
    //     不再是一条固定的 5 m 长箭头压在 7 m 窄路上。
    if (!e.standalone && e.lanes >= 2) {
      const carW = carHi - carLo;
      const per = carW / e.lanes;
      const ARROW_LEN = Math.min(u(4.6), Math.max(u(2.6), carW * 0.55));
      const ARROW_SPACING = u(50);
      // 进口标线组（斑马线 + 停止线 + 箭头 + 菱形）最多探出路口 ~18 m，
      // 留 20 m 才不会和它挤在一起
      const margin = u(20);
      const lo = s0 + margin;
      const hi = s1 - margin;
      const span = hi - lo;
      const tips: number[] = [];
      if (span >= ARROW_SPACING * 1.15) {
        // 长路段：按节奏排，首枚从 18% 处起，避免贴着路口
        for (let s = lo + span * 0.18; s <= hi; s += ARROW_SPACING) tips.push(s);
      } else if (span >= ARROW_LEN * 2.6) {
        tips.push((lo + hi) / 2);
      }
      for (let k = 0; k < tips.length; k++) {
        for (const sign of [1, -1]) {
          // 车道中心：取本向**最内侧**那条车道（2 车道时就是 ±车宽/4，
          // 4 车道时是 ±车宽/8 —— 原来的固定 ±车宽/4 会横跨在车道分界线上）
          const dc = mid + sign * per * 0.5;
          // 箭头必须整个落在车行道里，否则会啃到人行道
          if (dc + ARROW_LEN * 0.13 > carHi || dc - ARROW_LEN * 0.13 < carLo) continue;
          arrow(out, e, `flow_${i}_${k}_${sign > 0 ? 'p' : 'n'}`, tips[k], sign, dc, ARROW_LEN, 'straight', per);
        }
      }
    }

    // 路口端：进口标线组。
    // 整段都落在路口里的短边（shortA/shortB）不画 —— 它的"进口"就在路口中间，
    // 画上去会变成路口里一根孤零零的白杠。两端装不下两整套时也不画（见上面 `fits`）。
    if (!e.standalone) {
      if (drawA) approach(out, e, s0, 1, i * 2);
      if (drawB) approach(out, e, s1, -1, i * 2 + 1);
    }
  });

  // 折点补口：两条只在折点相接（不是路口）的边，标线在这里各收各的头，
  // 会在弯道处留下一道几十厘米的缺口 + 宽度差导致的错位。
  bendMarkings(net, out);
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
