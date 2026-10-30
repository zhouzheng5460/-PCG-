// 道路系统：从地块边图导出参数化道路网。
//
// 思路参考 three-roads 的 authoring → surface 两段式：先把"我想要什么路"
// 描述成横断面（红线宽 → 人行道 / 绿化带 / 车行道 / 车道数），再由横断面
// 生成条带几何；路口是独立的几何实体（圆盘 + 人行道转角环），不是把两条路
// 的多边形叠在一起。
//
// 与 three-roads 的区别：那边需要显式声明 junction intent（每条 approach 的
// lane role 映射），我们的路网是 Voronoi 对偶图上跑 A* 出来的，交叉点天然全部
// 由共享顶点给出，所以路口是"从图里读出来的"，不需要手写。
//
// 关键约束：地块边就是道路中线。这不是新发明的规则 —— 原版的路宽本来就是
// "地块内缩后留下的缝隙"，所以缝隙两侧的边界正好是建筑红线。我们只是把这条
// 缝隙按真实横断面切成 绿化带 / 人行道 / 车行道，绝不越界。

import { Pt } from '../core/geom';
import polygonClipping from 'polygon-clipping';
import type { Model } from '../town/model';
import type { Patch } from '../town/patch';
import { clamp, toCCW } from '../scene/types';
import { classRank } from '../town/edgeclass';
import { area, subtract } from '../town/zones';
import { cornerRadius, fitSection, specOf, u } from './spec';
import type { SurfaceFeature } from '../scene/types';

const MITER_LIMIT = 3.0;

/** 两端都是路口的短边，整段并入路口（错位路口合并） */
const MERGE_LEN = 2.6;

export type RoadClass = 'arterial' | 'collector' | 'local';

export interface RoadEdge {
  key: string;
  a: Pt;
  b: Pt;
  len: number;
  /** a→b 单位向量 */
  dir: Pt;
  insetL: number;
  insetR: number;
  patchL: Patch | null;
  patchR: Patch | null;
  arterial: boolean;
  cls: RoadClass;
  /** 车行道总宽 */
  carriage: number;
  /** 边线 → 左/右侧车行道边缘的距离 */
  carL: number;
  carR: number;
  swL: number;
  swR: number;
  vgL: number;
  vgR: number;
  lanes: number;
  laneWidth: number;
  /** 中央分隔带宽度（0 = 只画双黄线） */
  median: number;
  /** 是否为城外引道（两侧无地块） */
  standalone: boolean;
  /** 两端受路口影响需要收起的长度 */
  padA: number;
  padB: number;
  /** 该端整段落在路口里（收口距离被边长度截断）：不铺人行道 / 绿化带 */
  shortA: boolean;
  shortB: boolean;
}

export interface JunctionArm {
  /** 对应的边索引 */
  edge: number;
  /**
   * 这条臂所在的顶点（= 它自己那条边的这一端）。
   *
   * 单个路口时它就等于路口中心；**合并路口**（两个相隔 0.2~2.5 的顶点并成一个）
   * 时两端的臂锚在不同点上，收口距离必须从各自的锚点量起，否则合并出来的
   * 多边形会把两段路的中线搞混，铺出一块错位的沥青。
   */
  origin: Pt;
  /** 从路口中心指向这条路（单位向量） */
  dir: Pt;
  /** dir 的左法线 */
  n: Pt;
  /** 车行道相对中心线的左侧宽度（正） */
  curbL: number;
  /** 车行道相对中心线的右侧宽度（正） */
  curbR: number;
  /** 左侧人行道 / 绿化带宽度（车行道边缘 → 红线 = sw + vg） */
  swL: number;
  swR: number;
  vgL: number;
  vgR: number;
  /** 路面条带在这个路口端被切掉的长度（= 收口距离） */
  pad: number;
  /** 该臂对应边的哪一端（a=true） */
  atA: boolean;
  /** 这条路在街网里的等级 —— 决定转角半径与标线 */
  cls: RoadClass;
  /** 收口距离是不是被"边太短"截断的（= 这条路整段都落在路口里，没有直路段） */
  short: boolean;
}

export interface Junction {
  center: Pt;
  arms: JunctionArm[];
  degree: number;
  /** 这个路口吞掉的所有图顶点（合并路口有多个，单点路口只有一个） */
  nodes: Pt[];
}

/** 两条相邻臂之间的转角（路缘转角圆弧 + 两个切点） */
export interface JunctionCorner {
  /** 两条路缘线的交点（没有圆弧时就是街角尖） */
  x: Pt;
  /** 圆角弧的两个切点，落在两条臂的路缘上 */
  ta: Pt;
  tb: Pt;
  /** 圆角半径（0 = 街角太紧，退化成倒角） */
  r: number;
  /** 圆角弧圆心 */
  o: Pt;
  /** 扇区张角 */
  turn: number;
}

export interface RoadNet {
  edges: RoadEdge[];
  junctions: Junction[];
  /** 顶点 → 相邻边索引 */
  nodeEdges: Map<Pt, number[]>;
  /** 图顶点 → 它所属的路口索引（合并路口里一个路口有多个顶点） */
  nodeJunction: Map<Pt, number>;
  /** 地块内部路的出入口（世界坐标矩形）：人行道 / 绿化带要在这里断开 */
  driveways: Pt[][];
}

// ---------------------------------------------------------------- 横断面

interface Section {
  sw: number;
  vg: number;
  md: number;
  carriage: number;
  lanes: number;
  laneWidth: number;
}

/**
 * 红线宽 → 横断面。左右内缩不等时（一边主干道一边支路）分别裁人行道，
 * 保证两侧都恰好贴住各自地块的红线。
 */
/** 红线宽 → 横断面。分项来自 road/spec.ts 的规范表（车道 3.25~3.5 m、
 *  人行道 ≥1.2 m 可行走下限、绿化带按等级给），再按实际拿到的红线宽收放。 */
function makeSection(insetL: number, insetR: number, cls: RoadClass): Section {
  const f = fitSection(cls, insetL, insetR);
  return { sw: f.sw, vg: f.vg, md: f.md, carriage: f.carriage, lanes: f.lanes, laneWidth: f.laneWidth };
}

// ---------------------------------------------------------------- 偏移

function unit(p: Pt): Pt {
  const l = p.length;
  return l < 1e-9 ? new Pt(1, 0) : new Pt(p.x / l, p.y / l);
}

/** 左法线（沿前进方向左手边） */
function leftNormal(d: Pt): Pt {
  return new Pt(-d.y, d.x);
}

/**
 * 折线按有符号距离偏移。正 = 左法线方向。
 * 拐角用斜接，并限制在 MITER_LIMIT 以内，否则锐角处会甩出一根针。
 */
export function offsetLine(pts: Pt[], d: number): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  if (n === 0) return out;
  if (n === 1) return [pts[0].add(new Pt(0, d))];

  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (i === 0) {
      out.push(p.add(leftNormal(unit(pts[1].subtract(pts[0]))).scale(d)));
    } else if (i === n - 1) {
      out.push(p.add(leftNormal(unit(pts[n - 1].subtract(pts[n - 2]))).scale(d)));
    } else {
      const n0 = leftNormal(unit(p.subtract(pts[i - 1])));
      const n1 = leftNormal(unit(pts[i + 1].subtract(p)));
      const m = new Pt(n0.x + n1.x, n0.y + n1.y);
      const ml = m.length;
      if (ml < 1e-6) {
        out.push(p.add(n0.scale(d)));
        continue;
      }
      const u = new Pt(m.x / ml, m.y / ml);
      const cosHalf = Math.max(u.dot(n0), 1 / MITER_LIMIT);
      out.push(p.add(u.scale(d / cosHalf)));
    }
  }
  return out;
}

/**
 * 两条偏移线之间的条带。dA 必须大于 dB（dA 在左）。
 * 端点天然是垂直封口，因为 offsetLine 在端点用的是端段法线。
 */
export function bandBetween(pts: Pt[], dA: number, dB: number): Pt[] | null {
  if (Math.abs(dA - dB) < 1e-5) return null;
  const left = offsetLine(pts, Math.max(dA, dB));
  const right = offsetLine(pts, Math.min(dA, dB));
  if (left.length < 2) return null;
  return left.concat(right.slice().reverse());
}

/** 沿线段取参数区间 [t0,t1] 的子段 */
export function subLine(a: Pt, b: Pt, t0: number, t1: number): Pt[] {
  const at = (t: number) => new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  return [at(t0), at(t1)];
}

// ---------------------------------------------------------------- 建图

/** 地块边去重后变成道路段；宽度 = 两侧地块各自的内缩量之和 */
/** 点到环的距离（避障兜底用；只要距离量级，不做内外判定） */
function distToRing(ring: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L < 1e-12 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

export function buildRoadNet(model: Model): RoadNet {
  const vid = new Map<Pt, number>();
  const idOf = (p: Pt) => {
    let i = vid.get(p);
    if (i === undefined) {
      i = vid.size;
      vid.set(p, i);
    }
    return i;
  };

  interface Raw {
    a: Pt;
    b: Pt;
    patchL: Patch | null;
    patchR: Patch | null;
    seen: Set<Patch>;
  }
  const raw = new Map<string, Raw>();

  for (const patch of model.patches) {
    const shape = patch.shape;
    const n = shape.length;
    for (let i = 0; i < n; i++) {
      const v0 = shape[i];
      const v1 = shape[(i + 1) % n];
      const i0 = idOf(v0);
      const i1 = idOf(v1);
      const flip = i0 > i1;
      const a = flip ? v1 : v0;
      const b = flip ? v0 : v1;
      const key = `${Math.min(i0, i1)}:${Math.max(i0, i1)}`;

      let e = raw.get(key);
      if (!e) {
        e = { a, b, patchL: null, patchR: null, seen: new Set() };
        raw.set(key, e);
      }
      if (e.seen.has(patch)) continue;
      e.seen.add(patch);

      // 地块是逆时针的，边 a→b 的左侧就是该地块内部
      const ownsForward = shape.findEdge(a, b) !== -1;
      if (ownsForward) {
        if (!e.patchL) e.patchL = patch;
        else if (!e.patchR) e.patchR = patch;
      } else {
        if (!e.patchR) e.patchR = patch;
        else if (!e.patchL) e.patchL = patch;
      }
    }
  }

  const edges: RoadEdge[] = [];

  for (const [, e] of raw) {
    // 只保留两侧都有地块的边 —— 一环是城市边界，不是街道
    if (!e.patchL || !e.patchR) continue;
    // 两侧都必须真的有内容。城郊超出规划范围的地块没有 ward，
    // 若仍给它们铺路，就会出现"悬在空中的路网"（画面上只剩标线）。
    if (!e.patchL.ward || !e.patchR.ward) continue;
    // 禁绘区不再是"路要绕开的空洞"：它是一个正常参与规划的地块，
    // 有自己的地坪、内部路与建筑。这里若再按"边落在禁区内就整体跳过"，
    // 地块内缩留出的整条红线宽路面就会裸露成一条底色宽带（既不是路也不是地块），
    // 内部路也无从接到主路。所以路口/路面照常铺，禁绘区只是内容不同而已。

    // 避障模式下反过来：**禁区轮廓不当路**。
    // 路网在避障后已经从旁边绕过去了（见 field/obstacle.ts），如果还按"两侧都有
    // 地块就铺路"把禁区那一整圈铺上沥青，等于在绕行路和禁区之间再塞一条贴边的路 ——
    // 用户说的"路压着禁区"就是它。这一圈改成绿化隔离带：两边地块照常有红线内缩，
    // 中间那条带由地块自己的地表铺出来。
    if (model.params.block.zoneAvoid) {
      if (e.patchL.blocked || e.patchR.blocked) continue;
      // 布尔切块 + 焊接会在禁区轮廓上留下 0.3~8 m 的碎边（顶点被吸到 2 cm 内、
      // T 型连接又插了点），它们两侧都是普通地块，按上面那条判不掉，但铺出来
      // 就是"贴着禁区的一小截沥青"。这里按**让距**兜底：路面完全落在让距带里的
      // 边一律不铺 —— 禁区周围那一圈从此是干净的绿化隔离带。
      const pad = u(model.params.block.zoneAvoidPadM);
      const mx = (e.a.x + e.b.x) / 2;
      const my = (e.a.y + e.b.y) / 2;
      let nearest = Infinity;
      for (const ring of model.zonePolys) {
        nearest = Math.min(nearest, distToRing(ring, mx, my));
        if (nearest < pad * 0.75) break;
      }
      if (nearest < pad * 0.75) continue;
    }

    const insetL = model.insetForEdge(e.patchL, e.a, e.b);
    const insetR = model.insetForEdge(e.patchR, e.b, e.a);
    edges.push(makeEdge(model, e.a, e.b, insetL, insetR, e.patchL, e.patchR, false, `${idOf(e.a)}:${idOf(e.b)}`));
  }

  // 节点 → 边
  //
  // 先摘掉"悬空路"：两端都只有这一条边的路段，谁都不连（城郊两块孤立地夹出来的
  // 一条缝就会这样），铺上去只是空地上孤零零一块沥青板。
  // 真正的尽头路（cul-de-sac）一端仍是正常路口，度 ≥2，不会被误删。
  const degOf = new Map<Pt, number>();
  for (const e of edges) {
    degOf.set(e.a, (degOf.get(e.a) ?? 0) + 1);
    degOf.set(e.b, (degOf.get(e.b) ?? 0) + 1);
  }
  const linked = edges.filter((e) => (degOf.get(e.a) ?? 0) > 1 || (degOf.get(e.b) ?? 0) > 1);
  if (linked.length !== edges.length) {
    edges.length = 0;
    edges.push(...linked);
  }

  const nodeEdges = new Map<Pt, number[]>();
  const push = (p: Pt, i: number) => {
    const list = nodeEdges.get(p);
    if (list) list.push(i);
    else nodeEdges.set(p, [i]);
  };
  edges.forEach((e, i) => {
    push(e.a, i);
    push(e.b, i);
  });

  // ---- 路口 = **一簇相邻顶点**，不是一个顶点。
  //
  // 张量场切出来的"十字"极少是四条边共用一个顶点：它一般是两个（有时三四个）
  // 相隔 0.2~2.5 的三度顶点，中间夹一小段路。这是"切两刀"留下的必然产物，
  // 不是 bug —— 但它让"一个路口一段沥青"的模型彻底失效：按点各画一圈，
  // 得到的是两块互相压着、错位半个街区、中间还留一道缝的沥青台阶，
  // 街角的圆弧也各自朝不同方向拧。
  //
  // 正确做法是在建路口之前就把这一簇顶点**并成一个路口**：
  //   · 内部那几小段路整段取消（不铺路面、不铺人行道）；
  //   · 每一簇只生成一个路口多边形，臂从各自的锚点量收口距离。
  // 路网拓扑一点没动（顶点和边还是原来的），只是"画"的粒度和真实路口对齐了。
  const isJunction = (p: Pt) => (nodeEdges.get(p)?.length ?? 0) >= 3;

  const par = new Map<Pt, Pt>();
  for (const p of nodeEdges.keys()) par.set(p, p);
  const find = (p: Pt): Pt => {
    let r = p;
    while (par.get(r) !== r) r = par.get(r)!;
    let c = p;
    while (par.get(c) !== c) {
      const nx = par.get(c)!;
      par.set(c, r);
      c = nx;
    }
    return r;
  };
  const union = (a: Pt, b: Pt) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) par.set(ra, rb);
  };

  // ① 直接相连的短边：两个路口顶点挨得够近就并成一个路口
  for (const e of edges) {
    if (e.len > MERGE_LEN) continue;
    if (!isJunction(e.a) || !isJunction(e.b)) continue;
    union(e.a, e.b);
  }

  // ② 中间夹着"折点"的短链，也必须并。
  //
  // 这是漏得最隐蔽的一种：两个三度顶点相隔 1.5，但中间垫了一个度数 2 的折点
  // （1.5 被切成 0.8 + 0.7）。① 的要求是"一条边直接连着两个路口"，于是它俩
  // 一个都没并 —— 渲染出来正好是两块错开半个路口、中间一道缝的沥青台阶。
  // 这里从每个路口顶点沿 ≤MERGE_LEN 的短边做一次有界 BFS，只要能走到另一个
  // 路口顶点、总长仍 ≤MERGE_LEN，就合并，并把沿途的折点一起吸进这个路口。
  const absorbed = new Map<Pt, Pt>(); // 折点 → 被吸进的路口（根在下面统一解析）
  const links: { a: Pt; b: Pt; path: Pt[] }[] = [];
  for (const start of nodeEdges.keys()) {
    if (!isJunction(start)) continue;
    let frontier: { node: Pt; dist: number; path: Pt[] }[] = [{ node: start, dist: 0, path: [] }];
    const seen = new Set<Pt>([start]);
    for (let hop = 0; hop < 3; hop++) {
      const next: typeof frontier = [];
      for (const cur of frontier) {
        for (const ei of nodeEdges.get(cur.node) ?? []) {
          const e = edges[ei];
          if (e.len > MERGE_LEN) continue;
          const far = e.a === cur.node ? e.b : e.a;
          if (seen.has(far)) continue;
          const d = cur.dist + e.len;
          if (d > MERGE_LEN) continue;
          seen.add(far);
          const path = cur.path.concat([cur.node]);
          if (isJunction(far)) {
            if (find(far) !== find(start)) links.push({ a: start, b: far, path });
            continue;
          }
          next.push({ node: far, dist: d, path });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
  }
  for (const l of links) union(l.a, l.b);
  for (const l of links) {
    const ra = find(l.a);
    const rb = find(l.b);
    if (ra !== rb) continue; // 没并成（可能是单向发现的），跳过
    for (const p of l.path) if (!isJunction(p)) absorbed.set(p, ra);
  }

  // 顶点 → 簇根（路口顶点本身 + 被吸进来的折点）
  const rootOf = (p: Pt): Pt | null => {
    if (isJunction(p)) return find(p);
    return absorbed.get(p) ?? null;
  };

  // 簇：root → 顶点集合；臂：只属于一个簇的边（两端同簇 = 内部边，丢掉）
  const clusterNodes = new Map<Pt, Pt[]>();
  for (const p of nodeEdges.keys()) {
    const r = rootOf(p);
    if (r === null) continue;
    const list = clusterNodes.get(r);
    if (list) list.push(p);
    else clusterNodes.set(r, [p]);
  }
  const clusterArms = new Map<Pt, number[]>();
  for (const [root] of clusterNodes) clusterArms.set(root, []);
  edges.forEach((e, i) => {
    const ra = rootOf(e.a);
    const rb = rootOf(e.b);
    if (ra !== null && ra === rb) {
      // 内部边：整段并进路口，不铺任何东西
      e.padA = e.len;
      e.padB = e.len;
      e.shortA = true;
      e.shortB = true;
      return;
    }
    if (ra !== null) clusterArms.get(ra)!.push(i);
    if (rb !== null) clusterArms.get(rb)!.push(i);
  });

  const junctions: Junction[] = [];
  const nodeJunction = new Map<Pt, number>();
  for (const [root, nodes] of clusterNodes) {
    const list = clusterArms.get(root)!;
    if (list.length < 3) continue;

    // 路口中心：簇内顶点的形心。只用于"按角度排序"和兜底的扇形三角化，
    // 不参与收口计算（收口从各臂自己的锚点量）。
    let cx = 0;
    let cy = 0;
    for (const p of nodes) {
      cx += p.x;
      cy += p.y;
    }
    const center = new Pt(cx / nodes.length, cy / nodes.length);

    const arms: JunctionArm[] = [];
    for (const ei of list) {
      const e = edges[ei];
      // 这个簇里，这条边接在哪个顶点上
      const own0 = nodes.includes(e.a) ? e.a : e.b;
      const atA = own0 === e.a;
      const other = atA ? e.b : e.a;
      const dir = unit(other.subtract(own0));
      const n = leftNormal(dir);
      // 左法线是"出城方向"的左手边；从 a 端出发时它等于边的左侧，从 b 端出发时左右互换
      const curbL = atA ? e.carL : e.carR;
      const curbR = atA ? e.carR : e.carL;
      const swL = atA ? e.swL : e.swR;
      const swR = atA ? e.swR : e.swL;
      const vgL = atA ? e.vgL : e.vgR;
      const vgR = atA ? e.vgR : e.vgL;
      arms.push({
        edge: ei,
        origin: own0,
        dir,
        n,
        curbL,
        curbR,
        swL,
        swR,
        vgL,
        vgR,
        pad: 0,
        atA,
        cls: e.cls,
        short: false,
      });
    }

    // 逐臂求收口：别的路的"红线"（车行道 + 人行道 + 绿化带）扎进这条臂中心线的位置。
    //
    // 用红线而不是路缘 —— 收口线同时是街角铺装的切口，切在人行道外沿上，
    // 街角铺装才有一整条边可以对接，不会在路缘和铺装之间留一道缝。
    //
    // 臂的锚点各不相同（合并路口），所以不能再用"半宽 / sinθ"这个以路口中心
    // 为原点的近似式，必须真的求"本臂轴线 × 邻臂红线"的交点。带锚点的写法在
    // 单点路口下退化成原来那个式子，两种情形一套代码。
    for (const a of arms) {
      let pad = 0;
      for (const b of arms) {
        if (b === a) continue;
        const cross = Math.abs(a.dir.x * b.dir.y - a.dir.y * b.dir.x);
        // 共线 / 近乎共线的臂（一条直路的两段）不构成转角，跳过
        if (cross < 0.3) continue;
        for (const off of [b.curbL + b.swL + b.vgL, -(b.curbR + b.swR + b.vgR)]) {
          // b 的红线：过 b.origin + n_b·off，方向 dir_b
          const q = new Pt(b.origin.x + b.n.x * off, b.origin.y + b.n.y * off);
          const hit = lineHit(a.origin, a.dir, q, b.dir);
          if (!hit) continue;
          const d = (hit.x - a.origin.x) * a.dir.x + (hit.y - a.origin.y) * a.dir.y;
          if (d > pad) pad = d;
        }
      }
      const own = Math.max(a.curbL + a.swL + a.vgL, a.curbR + a.swR + a.vgR);
      // 三条臂几乎共线这种极端情况：退回按自身宽度的 1.2 倍
      if (pad < 1e-6) pad = own * 1.2;
      pad += 0.02;
      // 收口距离封顶 = **到下一个路口的链长**，不是"这条短边的半长"。
      //
      // 曾经封在 len*0.5：路网里 46% 的边短于 3 单位，其中一大半是夹在路口和
      // 一个"折点"（度数 2）之间的 0.5 单位碎边。按半长一封，这些臂的收口只剩
      // 0.25，路口根本没退到位，同时被打上 short 标记 —— 人行道、斑马线、停止线、
      // 箭头全部被跳过。于是整座城的路口看起来"什么都没有"。
      // 收口该受的约束不是"这条边长"，而是"这条臂到下一个路口还有多远"。
      pad = Math.max(pad, own * 0.55);
      const arc = chainLen(edges, nodeEdges, a);
      if (pad > arc * 0.95) a.short = true;
      a.pad = Math.min(pad, arc * 0.95);
    }

    const ji = junctions.length;
    junctions.push({ center, arms, degree: list.length, nodes });
    for (const p of nodes) nodeJunction.set(p, ji);
  }

  // 收口距离沿"链"分发：一条边不够吃就继续吃下一段（折点只是度数 2 的拐点，
  // 不是路口，它后面那段路属于同一个直路段）。
  //
  // 不分发的后果：0.5 单位碎边被收口整个吃掉 → 它的可见段为零 → 那一段路
  // 既没有沥青也没有人行道，路口和中段之间裂开一道缝。
  for (const j of junctions) {
    for (const a of j.arms) {
      let rem = a.pad;
      let ei = a.edge;
      let atA = a.atA;
      for (let guard = 0; guard < 8 && rem > 1e-6; guard++) {
        const e = edges[ei];
        const take = Math.min(rem, e.len);
        if (atA) e.padA = Math.max(e.padA, take);
        else e.padB = Math.max(e.padB, take);
        rem -= take;
        if (take < e.len - 1e-6) break;
        // 这一段被吃光：只有"度数 2 的折点"才允许继续，遇到路口就停
        const far = atA ? e.b : e.a;
        const list = nodeEdges.get(far) ?? [];
        if (list.length !== 2) break;
        const nxt = list[0] === ei ? list[1] : list[0];
        ei = nxt;
        atA = edges[nxt].a === far;
      }
    }
  }

  // short = 这一端没有直路段了（可见段 < 10%），人行道与进口标线都不该出现
  for (const e of edges) {
    e.shortA = e.len > 1e-6 && e.padA >= e.len * 0.9;
    e.shortB = e.len > 1e-6 && e.padB >= e.len * 0.9;
  }

  return { edges, junctions, nodeEdges, nodeJunction, driveways: model.driveways ?? [] };
}

function makeEdge(
  model: Model,
  a: Pt,
  b: Pt,
  insetL: number,
  insetR: number,
  patchL: Patch | null,
  patchR: Patch | null,
  standalone: boolean,
  key: string
): RoadEdge {
  // 等级由街网层级给出；拿不到（独立引道）才退回"按宽度猜"
  const known = model.roadClassOf(a, b);
  const cls: RoadClass = known ?? (standalone ? 'arterial' : (insetL + insetR) >= 0.86 ? 'collector' : 'local');
  const arterial = cls === 'arterial';
  const sec = makeSection(insetL, insetR, cls);
  const w = insetL + insetR;

  const swL = standalone ? 0 : Math.min(sec.sw, insetL * 0.92);
  const swR = standalone ? 0 : Math.min(sec.sw, insetR * 0.92);
  const vgL = standalone ? 0 : Math.min(sec.vg, Math.max(0, insetL - swL) * 0.9);
  const vgR = standalone ? 0 : Math.min(sec.vg, Math.max(0, insetR - swR) * 0.9);
  const carL = Math.max(0, insetL - swL - vgL);
  const carR = Math.max(0, insetR - swR - vgR);
  const carriage = Math.max(carL + carR, 0.02);
  const lanes = standalone ? 2 : sec.lanes;

  return {
    key,
    a,
    b,
    len: Pt.distance(a, b),
    dir: unit(b.subtract(a)),
    insetL,
    insetR,
    patchL,
    patchR,
    arterial,
    cls,
    carriage,
    carL,
    carR,
    swL,
    swR,
    vgL,
    vgR,
    lanes,
    laneWidth: carriage / lanes,
    median: standalone ? 0 : sec.md,
    standalone,
    padA: 0,
    padB: 0,
    shortA: false,
    shortB: false,
  };
}

/**
 * 一条臂从锚点出发、到**下一个路口**为止的路程（沿图走，不是直线距离）。
 *
 * 为什么要这个数：路网里 46% 的边短于 3 单位，其中多半是路口旁边一个
 * 度数 2 的折点切开来的碎边。收口距离若按"这条边长"封顶，这些臂就退不到位；
 * 而它真正能用的长度是从锚点到下一个路口的整段折线。
 */
function chainLen(edges: RoadEdge[], nodeEdges: Map<Pt, number[]>, a: JunctionArm): number {
  let sum = 0;
  let ei: number | null = a.edge;
  let from = a.origin;
  for (let guard = 0; guard < 16 && ei !== null; guard++) {
    const e = edges[ei];
    sum += e.len;
    const far = e.a === from ? e.b : e.a;
    const list = nodeEdges.get(far) ?? [];
    // 度数 2 = 折点，路还继续；度数 1 / ≥3 = 到头 / 到路口，停
    if (list.length !== 2) return sum;
    const nxt: number = list[0] === ei ? list[1] : list[0];
    ei = nxt;
    from = far;
  }
  return sum;
}

// ---------------------------------------------------------------- 路面几何

const Y_ROAD = 0.012;
const Y_WALK = 0.02;
const Y_VERGE = 0.019;

/** 边在参数区间 [t0,t1] 内的可见部分（t 从 a 起算，1 = b） */
export function visibleSpan(e: RoadEdge): [number, number] {
  if (e.len < 1e-6) return [0, 1];
  const t0 = e.padA / e.len;
  const t1 = 1 - e.padB / e.len;
  if (t1 <= t0) {
    const mid = 0.5;
    return [mid - 0.001, mid + 0.001];
  }
  return [t0, t1];
}

/** 生成一条路的全部贴地要素：车行道、人行道、绿化带、路口圆盘与转角环 */
export function roadSurfaces(net: RoadNet, out: SurfaceFeature[]): void {
  // 先把每个路口的几何算出来，两处都要用：路口自身铺装、直路段条带的端头切裁。
  //
  // 为什么要裁条带端头：端头是"垂直于本条路"的一刀，而斜交路口里邻路的车行道
  // 是斜着扎进来的 —— 端头的外侧角一定先跨进邻路车行道，留下一块 0.02~0.3 u²
  // 的米色/绿色三角压在沥青上（用户截图里最显眼的那处）。
  // 按几何求"斜切端头"要逐角度推公式，直接做减法最稳。
  const jGeom = new Map<Pt, JunctionGeom | null>();
  net.junctions.forEach((j) => jGeom.set(j.center, junctionGeom(j)));

  // 每个路口：每条臂的车行道矩形（附带它属于哪条边）。
  // 条带的端头只被**别的**臂裁 —— 裁自己的车行道会把整条人行道削掉。
  const armQuads = net.junctions.map((j) => ({
    center: j.center,
    list: j.arms.map((a) => {
      const quad = armRoadQuad(a);
      return { edge: a.edge, quad, box: bboxOfRing(quad) };
    }),
  }));

  /**
   * 裁掉条带上"压在别的路口车行道上"的部分。
   *
   * 注意不能只看本条路两端的路口：街区之间常常出现"路口旁还有一个度 2 的短顶点"
   * （切块留下一段 0.2~0.4 的短边），那条短边两端都不是路口，拿不到任何收口距离，
   * 于是它的人行道 / 绿化带一直铺进路口，压在横向车行道上 —— 就是截图里那条
   * 斜穿路口的米色/绿色细带。所以按**几何邻近**取路口：端头半径内的路口都算。
   */
  const NEAR = 3.0;
  const trim = (ring: Pt[] | null, e: RoadEdge, idx: number): Pt[] | null => {
    if (!ring) return null;
    const others: Pt[][] = [];
    let box: BBox | null = null;
    const own = bboxOfRing(ring);
    for (const j of armQuads) {
      const nearA = Math.hypot(j.center.x - e.a.x, j.center.y - e.a.y) < NEAR;
      const nearB = Math.hypot(j.center.x - e.b.x, j.center.y - e.b.y) < NEAR;
      if (!nearA && !nearB) continue;
      for (const it of j.list) {
        if (it.edge === idx) continue;
        if (!boxesOverlap(own, it.box)) continue;
        others.push(it.quad);
        box = box ? unionBox(box, it.box) : it.box;
      }
    }
    if (others.length === 0 || !box) return ring;
    if (!boxesOverlap(own, box)) return ring;

    let parts: Pt[][];
    try {
      parts = subtract(ring, others);
    } catch {
      return ring;
    }
    // 整条都压在别人的车行道上 → 这块条带根本不该存在（短边常见）
    if (parts.length === 0) return null;
    let best = parts[0];
    let bestA = Math.abs(signedArea(best));
    for (const p of parts) {
      const a2 = Math.abs(signedArea(p));
      if (a2 > bestA) {
        best = p;
        bestA = a2;
      }
    }
    // 裁完只剩渣：这块条带本来就整条压在路口里，直接不铺
    if (bestA < 0.004) return null;
    return best.length >= 3 ? best : ring;
  };

  // 出入口断口：地块内部路要穿过"人行道 + 绿化带"才够得着车行道。
  // 不切开的话，绿带和灰带会横在引道上方，沥青看着像从地下钻过去 ——
  // 用户说的"只是模型看起来叠在一起"就是这个。
  const cuts = net.driveways.map((r) => ({ ring: r, box: bboxOfRing(r) }));

  /**
   * 把一条铺装带在出入口处切开。返回可能的多块（一块带子被门口截成两段很常见，
   * 所以不能像 trim 那样只留最大的一块，否则人行道会在门口少一截）。
   */
  const cutBands = (ring: Pt[]): Pt[][] => {
    if (cuts.length === 0) return [ring];
    let parts: Pt[][] = [ring];
    for (const c of cuts) {
      let next: Pt[][] = [];
      for (const p of parts) {
        if (!boxesOverlap(bboxOfRing(p), c.box)) {
          next.push(p);
          continue;
        }
        let sub: Pt[][] = [];
        try {
          sub = subtract(p, [c.ring]);
        } catch {
          sub = [p];
        }
        for (const q of sub) if (q.length >= 3 && Math.abs(signedArea(q)) > 0.006) next.push(q);
      }
      parts = next;
      if (parts.length === 0) break;
    }
    return parts;
  };

  net.edges.forEach((e, i) => {
    if (e.len < 1e-6) return;
    // 整条边都并进路口了（合并路口内部那几小段）：路口多边形会覆盖它，
    // 这里再铺一层只会得到一条 0.002 长的碎面
    if (e.padA + e.padB >= e.len * 0.995) return;
    const [t0, t1] = visibleSpan(e);
    const seg = subLine(e.a, e.b, t0, t1);

    // 车行道（在路口铺装之下，不必裁）
    const car = bandBetween(seg, e.carL, -e.carR);
    if (car) {
      out.push({
        name: `road_${i}`,
        group: 'road/surface',
        ring: toCCW(car),
        mat: 'asphalt',
        y: Y_ROAD,
      });
    }

    // 藏在路口内部的那一小段（两端收口都顶到 0.5 边长，或者本身就短于一块人行道）：
    // 它没有"直路段"可言，铺人行道 / 绿化带只会变成路口里一块孤岛或一条斜穿的细带。
    if (e.len < 0.5 || (e.shortA && e.shortB)) return;

    /** 一条带子：先按路口裁，再按出入口切，每一块都单独铺 */
    const put = (name: string, group: string, mat: 'grass' | 'concrete', y: number, raw: Pt[] | null) => {
      const t = trim(raw, e, i);
      if (!t) return;
      cutBands(t).forEach((q, k) => {
        out.push({ name: k === 0 ? name : `${name}_${k}`, group, ring: toCCW(q), mat, y });
      });
    };

    // 绿化带（红线最外侧）
    if (e.vgL > 1e-3) put(`verge_${i}_L`, 'road/verge', 'grass', Y_VERGE, bandBetween(seg, e.insetL, e.insetL - e.vgL));
    if (e.vgR > 1e-3) put(`verge_${i}_R`, 'road/verge', 'grass', Y_VERGE, bandBetween(seg, -(e.insetR - e.vgR), -e.insetR));

    // 人行道
    if (e.swL > 1e-3) put(`walk_${i}_L`, 'road/sidewalk', 'concrete', Y_WALK, bandBetween(seg, e.insetL - e.vgL, e.insetL - e.vgL - e.swL));
    if (e.swR > 1e-3) put(`walk_${i}_R`, 'road/sidewalk', 'concrete', Y_WALK, bandBetween(seg, -(e.insetR - e.vgR - e.swR), -(e.insetR - e.vgR)));
  });

  bendSurfaces(net, out, trim, cutBands);

  net.junctions.forEach((j, ji) => {
    out.push(...junctionSurfaces(j, ji, jGeom.get(j.center) ?? null));
  });
}

// ---------------------------------------------------------------- 折点补面

/**
 * 折点（度数 2 的拐点）处的转角补面。
 *
 * 直路段是**逐边**生成的正交条带：两端都是垂直于本段的一刀平口。两条边在一个
 * 折点上以转角相接时，平口与平口之间在外侧留下一块楔形裸地 —— 内侧反而是重叠，
 * 一点看不出来。路口有专门的转角几何，折点没有（它不是路口，没有臂、没有收口），
 * 于是整座城每个转弯处都"断"一下：实测 26 个转角 ≥20° 的折点里 24 个裸缝，
 * 90° 的折点外侧一整块三角形直接露出地面。
 *
 * 补法是**斜接（miter）**：把两侧在该层的"外沿偏移线"求交，交点 M 就是转角
 * 应有的尖角。三层各补各的环带（外斜接 − 内斜接 的环，而不是三块实心楔形），
 * 这样绿带 / 人行道 / 车行道各自连续，也不会互相盖掉 —— 实心楔形会按面积大小
 * 叠成一坨：人行道是 0.02、车行道只有 0.012，铺满的楔形会把人行道的楔形整个
 * 盖住，转角看上去是一整块沥青。
 *
 * 斜接距离是 w / cos(转角/2)：90° 时 1.41w，120° 时 2w，越接近掉头越远。但真正
 * 会炸的不是转角，是**两侧宽度差** —— 两条近乎共线的路，宽度差 0.7 时交点会飞到
 * 0.7/sin(2°) ≈ 20 单位之外。所以 cap 按宽度的 2.2 倍给，超了就退化成弦切：
 * 宁可把那个小尖切平，也不要甩出一根 4 单位长的沥青尖刺。
 */
function bendSurfaces(
  net: RoadNet,
  out: SurfaceFeature[],
  trim: (ring: Pt[] | null, e: RoadEdge, idx: number) => Pt[] | null,
  cutBands: (ring: Pt[]) => Pt[][]
): void {
  const LAYERS: { group: string; mat: 'asphalt' | 'concrete' | 'grass'; y: number; tag: string }[] = [
    { group: 'road/surface', mat: 'asphalt', y: Y_ROAD, tag: 'road' },
    { group: 'road/sidewalk', mat: 'concrete', y: Y_WALK, tag: 'walk' },
    { group: 'road/verge', mat: 'grass', y: Y_VERGE, tag: 'verge' },
  ];
  let seq = 0;

  for (const [V, list] of net.nodeEdges) {
    if (list.length !== 2) continue;
    // 已经被并进路口簇的折点：那段由路口喉部盖住，这里再补会多出一块斜三角
    if (net.nodeJunction.has(V)) continue;
    const e1 = net.edges[list[0]];
    const e2 = net.edges[list[1]];
    if (!e1 || !e2 || e1 === e2) continue;
    if (e1.len < 1e-6 || e2.len < 1e-6) continue;
    // 这一端的条带被收口吃掉了（收口顺着折点往这边传过）：补面会和喉部打架
    if (padAt(e1, V) > 1e-6 || padAt(e2, V) > 1e-6) continue;
    if (e1.padA + e1.padB >= e1.len * 0.995) continue;
    if (e2.padA + e2.padB >= e2.len * 0.995) continue;

    const f1 = bendFrame(e1, V, 'in');
    const f2 = bendFrame(e2, V, 'out');
    const cross = f1.uIn.x * f2.uOut.y - f1.uIn.y * f2.uOut.x;
    const dot = f1.uIn.dot(f2.uOut);
    if (dot < -0.9) continue; // 近似掉头：两侧外沿几乎平行，斜接点飞到天边
    const turn = Math.abs(Math.atan2(cross, dot));
    if (turn < 0.02) continue; // 几乎是直穿，平口本来就贴在一起

    // 外侧 = 转弯的背侧。左转（cross > 0）外侧在行进方向的右手边
    const leftTurn = cross > 0;
    const o1 = leftTurn ? new Pt(-f1.L.x, -f1.L.y) : f1.L;
    const o2 = leftTurn ? new Pt(-f2.L.x, -f2.L.y) : f2.L;

    LAYERS.forEach((lay, li) => {
      const wO1 = leftTurn ? f1.right[li] : f1.left[li];
      const wO2 = leftTurn ? f2.right[li] : f2.left[li];
      if (wO1 < 1e-3 && wO2 < 1e-3) return;
      // 内沿 = 更靠里的那一层的外沿；车行道没有更里面的一层，收到折点本身
      const wI1 = li === 0 ? 0 : leftTurn ? f1.right[li - 1] : f1.left[li - 1];
      const wI2 = li === 0 ? 0 : leftTurn ? f2.right[li - 1] : f2.left[li - 1];

      const at = (o: Pt, w: number) => new Pt(V.x + o.x * w, V.y + o.y * w);
      const q1o = at(o1, wO1);
      const q2o = at(o2, wO2);
      const q1i = at(o1, wI1);
      const q2i = at(o2, wI2);
      const mo = miterOf(V, q1o, f1.uIn, q2o, f2.uOut, Math.max(wO1, wO2));
      const mi = miterOf(V, q1i, f1.uIn, q2i, f2.uOut, Math.max(wI1, wI2));

      // 斜接点收不到（转角太急 / 两侧宽度差太大）：退化成弦切，直接把两个
      // 外角连起来。宁可切掉一点转角，也不要甩出一根 4 单位的沥青尖刺。
      const seqPts = mo
        ? [q1o, mo, q2o, q2i, ...(mi ? [mi] : []), q1i]
        : [q1o, q2o, q2i, ...(mi ? [mi] : []), q1i];
      let ring = dedupeRing(seqPts, 0.006);
      if (ring.length < 3) return;
      if (Math.abs(signedArea(ring)) < 1e-4) return;
      if (!isSimpleRing(ring)) return;
      ring = toCCW(ring);
      // 用和直路段同一套裁法：转角面同样可能压在邻路的车行道上（急角折点）
      const t = trim(ring, e1, list[0]);
      if (!t) return;
      cutBands(t).forEach((q, k) => {
        out.push({
          name: `bend_${seq++}_${lay.tag}${k ? `_${k}` : ''}`,
          group: lay.group,
          ring: toCCW(q),
          mat: lay.mat,
          y: lay.y,
        });
      });
    });
  }
}

/** 折点这一端被路口收口吃掉的长度 */
function padAt(e: RoadEdge, V: Pt): number {
  return e.a === V ? e.padA : e.padB;
}

/** 一条边在折点 V 处的局部坐标：行进方向 + 左法线 + 左右两侧各层的累计宽度 */
interface BendFrame {
  /** 进入 V 的行进方向（e1 用） */
  uIn: Pt;
  /** 离开 V 的行进方向（e2 用） */
  uOut: Pt;
  /**
   * **过 V 的那条路**的行进方向的左法线。
   *
   * 坑就在这儿：折点两侧一条是"进来"、一条是"出去"，它们"背着 V 走"的方向
   * 恰好相反。若两条边都按"从 V 指向边内"取法线，两侧外沿会落到马路的两边，
   * 斜接点直接飞到对面车道上去。所以必须统一按"车经过 V 时的行进方向"取。
   */
  L: Pt;
  /** 左 / 右两侧：车行道沿、人行道外沿、红线外沿（相对上面的行进方向） */
  left: [number, number, number];
  right: [number, number, number];
}

function bendFrame(e: RoadEdge, V: Pt, role: 'in' | 'out'): BendFrame {
  const atB = e.b === V;
  const n = new Pt(-e.dir.y, e.dir.x); // a→b 的左法线
  const uIn = atB ? e.dir : new Pt(-e.dir.x, -e.dir.y);
  const uOut = new Pt(-uIn.x, -uIn.y);
  const fwd = role === 'in' ? uIn : uOut;
  // 行进方向与 a→b 同向时"左"就是 +n，反向时左右互换
  const same = fwd.x * e.dir.x + fwd.y * e.dir.y > 0;
  const L = same ? n : new Pt(-n.x, -n.y);
  const pick = (l: number, r: number): [number, number] => (same ? [l, r] : [r, l]);
  const [l0, r0] = pick(e.carL, e.carR);
  const [l1, r1] = pick(e.carL + e.swL, e.carR + e.swR);
  const [l2, r2] = pick(e.carL + e.swL + e.vgL, e.carR + e.swR + e.vgR);
  return { uIn, uOut, L, left: [l0, l1, l2], right: [r0, r1, r2] };
}

/**
 * 两条外沿偏移线的交点（斜接点）。收不到就返回 null，由调用方退化成弦切。
 *
 * 斜接距离是 w / cos(转角/2)：转角 90° 时 1.41w，120° 时 2w，越接近掉头越远。
 * 但真正会炸的是**两侧宽度差**：两条近乎共线的路，宽度差 0.7 时交点会飞到
 * 0.7 / sin(2°) ≈ 20 单位之外 —— 那不是转角，那是"宽路到头、窄路接上"，
 * 本来就不该补。所以封顶按宽度的 2.2 倍给（能容下 126° 以内的转角），
 * 超出就取弦，转角处切一个平口 —— 从这个尺度看就是"缘石转了个弯"。
 */
function miterOf(V: Pt, p: Pt, dp: Pt, q: Pt, dq: Pt, w: number): Pt | null {
  const m = lineHit(p, dp, q, dq);
  if (!m) return null;
  const d = Math.hypot(m.x - V.x, m.y - V.y);
  return d <= 2.2 * Math.max(w, 0.05) ? m : null;
}

/** 两条直线（点 + 方向）求交 */
function lineHit(p: Pt, dp: Pt, q: Pt, dq: Pt): Pt | null {
  const den = dp.x * dq.y - dp.y * dq.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * dq.y - (q.y - p.y) * dq.x) / den;
  return new Pt(p.x + dp.x * t, p.y + dp.y * t);
}

/**
 * 一条臂在收口线上的两个车行道边缘点。
 * 从 a.origin 量（不是路口中心）—— 合并路口的各臂锚在不同顶点上。
 */
export function armPts(a: JunctionArm) {
  const at = (d: number) => new Pt(a.origin.x + a.dir.x * a.pad + a.n.x * d, a.origin.y + a.dir.y * a.pad + a.n.y * d);
  return { pL: at(a.curbL), pR: at(-a.curbR) };
}

/** 路缘外偏移 w 之后的两条线：用于求"路缘 × 红线"的交点 */
function offLine(p: Pt, n: Pt, w: number) {
  return new Pt(p.x + n.x * w, p.y + n.y * w);
}

/**
 * 一条臂的"喉部矩形"：从锚点一直铺到收口线，横向 [-curbR, +curbL]。
 *
 * 两端各多铺 0.03 —— 和直路段条带、和邻臂都留一点重叠，缝隙在接缝处
 * 只会露出下面一层沥青，不会露出地面。
 */
function armThroat(a: JunctionArm): Pt[] {
  const over = 0.03;
  const at = (t: number, d: number) =>
    new Pt(a.origin.x + a.dir.x * t + a.n.x * d, a.origin.y + a.dir.y * t + a.n.y * d);
  const p = a.pad + over;
  return [at(-over, a.curbL), at(p, a.curbL), at(p, -a.curbR), at(-over, -a.curbR)];
}

/**
 * 两条相邻臂之间的街角转角 —— 真正的路缘转角（curb return）。
 *
 * 两条路缘线交于 x，切点 ta / tb 从 x 沿各自路缘量 t = r·tan(θ/2)，
 * 圆弧圆心 o 在两条路缘的角平分线上、距 x 为 r/sin(θ/2)。弧朝 x 方向鼓，
 * 把街角块靠近路口的那一小撮切给车行道 —— 这就是缘石转弯半径做的事。
 *
 * 半径受**三重**约束，缺一就会出现翻面或吃掉地块：
 *   1. 规范值（road/spec.ts：主干路 15 m、次干路 10 m、支路 6 m）；
 *   2. 可用切线长 reach（切点不能越过收口点，否则弧长到直路段上去）；
 *   3. 最窄一条铺装带宽度 narrowW —— 弧一旦鼓出红线，圆角就切到地块转角里了。
 *
 * 第 3 条是本尺度的硬约束：1 单位 = 7 m 时，两个等宽路口的街角块恰好是
 * w×w（10.5 m 的支路 → 2 m×2 m），而真实缘石半径 3~6 m（0.43~0.86 单位）
 * 比它还大。所以这里的半径基本等于人行道宽（1.3~2.7 m），街角是"方块带一点
 * 圆"——这正是小区路口的真实样子；再大就只能切地块了。
 */
function cornerOf(a: JunctionArm, b: JunctionArm, cls: RoadClass, narrowW: number): JunctionCorner | null {
  const A = armPts(a);
  const B = armPts(b);
  const x = lineHit(A.pL, a.dir, B.pR, b.dir);
  if (!x) return null;

  // 按角度排好序的相邻臂之间必须是凸扇区（a.dir 逆时针转到 b.dir 小于 π）。
  // 凹扇区（叉积 ≤ 0）那里两条人行道本来就相互重叠，不画转角才是对的。
  const cr = a.dir.x * b.dir.y - a.dir.y * b.dir.x;
  if (cr <= 1e-3) return null;

  const dA = Pt.distance(x, A.pL);
  const dB = Pt.distance(x, B.pR);
  if (dA < 1e-4 || dB < 1e-4) return null;

  // 两条路缘从 x 指向收口点的方向
  const uA = a.dir.scale(Math.sign((A.pL.x - x.x) * a.dir.x + (A.pL.y - x.y) * a.dir.y) || 1);
  const uB = b.dir.scale(Math.sign((B.pR.x - x.x) * b.dir.x + (B.pR.y - x.y) * b.dir.y) || 1);
  const turn = Math.acos(clamp(uA.dot(uB), -1, 1));
  if (turn < 0.25 || turn > Math.PI - 0.2) return null;

  // 退化成倒角：两条路缘直接斜切。x 只有在收口线之外才可用（否则会扎到
  // 邻臂的铺装里），不然就用收口点连弦。
  const chamfer = (): JunctionCorner => {
    const usable = dA > 1e-3 && dB > 1e-3;
    return { x, ta: usable ? x : A.pL, tb: usable ? x : B.pR, r: 0, o: x, turn };
  };

  const reach = 0.9 * Math.min(dA, dB);
  if (reach < 1e-4) return chamfer();

  // 三道封顶：规范值 / 可用切线长 / 最窄铺装带，再加一条 —— 弧不许鼓过
  // 对面车道的中心线（r 超过半幅车行道，转出来的路口就是"喇叭口"）。
  const fit = narrowW > 1e-3 ? Math.min(reach, narrowW * 0.92) : reach;
  const roadCap = Math.max(0.05, 0.5 * Math.min(a.curbL + a.curbR, b.curbL + b.curbR));
  const want = Math.min(cornerRadius(cls, reach / Math.max(Math.tan(turn / 2), 1e-3)), fit, roadCap);
  // 有地儿就必须是**弧**，哪怕只有 1 m 半径 —— 斜切会让街角出现一道直线的"削角"，
  // 俯视图上一眼就能看出这是几何塌了，而不是设计如此。
  const t = want * Math.tan(turn / 2);
  if (t < 1e-4) return chamfer();

  const r = want;
  const bis = unit(uA.add(uB));
  const dist = r / Math.sin(turn / 2);
  return {
    x,
    ta: new Pt(x.x + uA.x * t, x.y + uA.y * t),
    tb: new Pt(x.x + uB.x * t, x.y + uB.y * t),
    r,
    o: new Pt(x.x + bis.x * dist, x.y + bis.y * dist),
    turn,
  };
}

/** 圆弧采样（含两端点）。半径按端点到圆心的实际距离，外偏弧直接复用。 */
function arcPts(o: Pt, p0: Pt, p1: Pt, n: number): Pt[] {
  const r0 = Pt.distance(o, p0);
  const r1 = Pt.distance(o, p1);
  const a0 = Math.atan2(p0.y - o.y, p0.x - o.x);
  const a1 = Math.atan2(p1.y - o.y, p1.x - o.x);
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const ang = a0 + d * t;
    const rr = r0 + (r1 - r0) * t;
    out.push(new Pt(o.x + Math.cos(ang) * rr, o.y + Math.sin(ang) * rr));
  }
  return out;
}

/** 沿街角弧取这么多段。4 段在 90° 转角上是 22.5°/段，肉眼已经是圆的 */
const ARC_SEGS = 4;

/**
 * 街角铺装（给定这一层的两条铺装带宽度 wA / wB），返回一个多边形。
 *
 * 形状 = **街角块减去缘石圆弧**：
 *   A.pL → ta → 圆弧 → tb → B.pR → bOut → xo → aOut → 闭合
 * 内边是路缘（直的 + 圆角弧），外边是四条边拼出来的红线折线：两条垂足
 * （aOut / bOut，收口线上的外端）夹着两条红线的交点 xo。少了那两个垂足，
 * 外边界就会变成一条从 B.pR 直插 xo 的斜边，横穿圆弧 —— 那是自交的来源。
 *
 * 不能按"等宽环带"做（曾经的做法）：街角是个**内凹**转角，向外偏移时带宽会
 * 自动变厚，用"把弧按半径 r+w 外推"来近似的后果是——当 r < w（本尺度几乎
 * 总是）外推点会跨过圆心落到另一侧，整片铺装翻面成蝴蝶结。这里干脆不求外推弧：
 * 外边直接取红线本身，宽度由几何自然长出来，既不会翻也不会漏。
 */
export function cornerPaving(
  c: JunctionCorner,
  center: Pt,
  a: JunctionArm,
  b: JunctionArm,
  wA: number,
  wB: number
): Pt[] | null {
  const A = armPts(a);
  const B = armPts(b);
  const aOut = offLine(A.pL, a.n, wA);
  const bOut = offLine(B.pR, b.n, -wB);
  const xo = lineHit(aOut, a.dir, bOut, b.dir);

  // 外边一定存在：两条红线近乎平行时交点在很远处，那样的转角本来就不该铺
  if (!xo) return null;
  if (Pt.distance(xo, center) > 8 * Math.max(wA + wB, a.pad + b.pad, 0.5)) return null;

  // 外尖必须在**路缘转角**的外侧。缩回转角之内意味着这个街角块被邻路的车行道
  // 咬掉了，闭环必然自交 —— 宁可不铺。收口线之内则是合法的（第三条臂更宽时，
  // 收口线被推得更远），那时外边界会自然形成一个凹口，正好让位给那条臂的铺装。
  const beyond = (q: Pt, dir: Pt) => (xo.x - q.x) * dir.x + (xo.y - q.y) * dir.y >= -1e-6;
  if (!beyond(c.x, a.dir) || !beyond(c.x, b.dir)) return null;

  const inner = c.r > 1e-4 ? arcPts(c.o, c.ta, c.tb, ARC_SEGS) : [c.x];
  const ring = dedupeRing([A.pL, ...inner, B.pR, bOut, xo, aOut]);
  if (ring.length >= 3 && Math.abs(signedArea(ring)) > 1e-7 && isSimpleRing(ring)) return ring;

  // 退路：不收弧，直接铺"两条路缘之间的方块"（A.pL → B.pR → 两条红线）。
  // 曾经用两条街带围成的平行四边形兜底，但它会在转角外侧甩出一个尖角，
  // 俯视图上就是一个扎进路面的三角刺 —— 宁可这个角是平的，也不要刺。
  const flat = dedupeRing([A.pL, B.pR, bOut, aOut]);
  if (flat.length < 3) return null;
  if (Math.abs(signedArea(flat)) < 1e-7) return null;
  if (!isSimpleRing(flat)) return null;
  return flat;
}

/**
 * 一条臂的车行道矩形（路口中心 → 收口线，宽 = curbL + curbR，两端各外扩 0.03）。
 * 用途：把"不该压在车行道上"的铺装裁掉 —— 斜交路口尤其容易出错。
 */
function armRoadQuad(a: JunctionArm): Pt[] {
  const side = (d: number) => new Pt(a.origin.x + a.n.x * d, a.origin.y + a.n.y * d);
  const far = (p: Pt) => new Pt(p.x + a.dir.x * (a.pad + 0.03), p.y + a.dir.y * (a.pad + 0.03));
  const p0 = side(a.curbL);
  const p1 = side(-a.curbR);
  return [p0, far(p0), far(p1), p1];
}

/**
 * 把街角铺装里压在任一臂车行道上的部分裁掉。
 *
 * 为什么必须裁：街角块的形状是"两条路缘 + 圆角弧 + 两条红线"拼出来的，
 * 这在直角路口里天生严丝合缝；但张量场切出来的十字常常是 60°~120° 的斜交，
 * 两臂的收口距离不相等，街角块就有一角伸进对面车行道，俯视图上就是一块
 * 米色（人行道）或绿色（绿化带）方块贴在沥青上 —— 用户截图里最刺眼的那处。
 * 与其逐个角度分析几何，不如直接做减法：这一块本来就不该盖在车行道上。
 */
export function clipOffCarriageway(ring: Pt[], j: Junction): Pt[] | null {
  const quads = j.arms.map((a) => armRoadQuad(a)).filter((q) => q.length >= 3);
  if (quads.length === 0) return ring;

  let parts: Pt[][];
  try {
    parts = subtract(ring, quads);
  } catch {
    return ring;
  }
  if (parts.length === 0) return null;

  let best = parts[0];
  let bestA = area(best);
  for (const p of parts) {
    const a = area(p);
    if (a > bestA) {
      best = p;
      bestA = a;
    }
  }
  // 裁完只剩渣（< 1 m²）就别铺了，否则会在路口角上留一条毛刺
  if (bestA < 0.02) return null;
  return best.length >= 3 ? best : null;
}

/** 环形多边形是否简单（无自交、无重合点）。n ≤ 10，直接 O(n²) */
function isSimpleRing(ring: Pt[]): boolean {
  const n = ring.length;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (Pt.distance(a, b) < 1e-6) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);
      if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
          ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) return false;
    }
  }
  return true;
}

/** 轴对齐包围盒（只用于预筛，不参与几何） */
interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function bboxOfRing(ring: Pt[]): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.x1 >= b.x0 && b.x1 >= a.x0 && a.y1 >= b.y0 && b.y1 >= a.y0;
}

function unionBox(a: BBox, b: BBox): BBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** 有向面积（判断退化用） */
function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** 一个路口的几何：排序后的臂、每两个相邻臂之间的转角、以及车行道路面多边形 */
export interface JunctionGeom {
  arms: JunctionArm[];
  corners: (JunctionCorner | null)[];
  /** 路面多边形的顶点序列（可能自交，用于兜底的扇形三角化） */
  pts: Pt[];
  /** 自交检测通过的完整多边形（null = 只能三角化） */
  ring: Pt[] | null;
}

export function junctionGeom(j: Junction): JunctionGeom | null {
  if (j.arms.length < 3) return null;

  // 按角度排序，保证绕行方向一致（张角是 0~2π 的连续序列）
  const arms = j.arms
    .map((a) => ({ a, ang: Math.atan2(a.dir.y, a.dir.x) }))
    .sort((p, q) => p.ang - q.ang)
    .map((p) => p.a);

  const corners: (JunctionCorner | null)[] = [];
  for (let k = 0; k < arms.length; k++) {
    const a = arms[k];
    const b = arms[(k + 1) % arms.length];
    const cls = classRank(a.cls) >= classRank(b.cls) ? a.cls : b.cls;
    // 可用宽度按"整条铺装带"（人行道 + 绿化带）算 —— 缘石弧允许吃进绿化带，
    // 只按人行道宽封顶会把半径压到 1 m 出头，转角看上去就是一记斜切。
    const walks = [a.swL + a.vgL, b.swR + b.vgR].filter((w) => w > 1e-3);
    const narrow = walks.length ? Math.min(...walks) : 0;
    corners.push(cornerOf(a, b, cls, narrow));
  }

  // 车行道路面：绕路口一圈，逐臂推到收口线，臂与臂之间直接连线（倒角）。
  // 这条倒角边和街角铺装的封口弦是同一条线，两边严丝合缝。
  const road: Pt[] = [];
  for (let k = 0; k < arms.length; k++) {
    const A = armPts(arms[k]);
    road.push(A.pR, A.pL);
    const c = corners[k];
    if (c && c.r > 1e-4) {
      for (const p of arcPts(c.o, c.ta, c.tb, ARC_SEGS).slice(1)) road.push(p);
    }
  }
  const pts = dedupeRing(road);
  const ring = pts.length >= 3 && isSimpleRing(pts) ? pts : null;
  return { arms, corners, pts, ring };
}

/** 路口车行道路面多边形（给"直路段条带端头切裁"用） */
function junctionRoadRing(j: Junction): Pt[] | null {
  return junctionGeom(j)?.ring ?? null;
}

/**
 * 路口铺装。
 *
 * 旧实现是"车行道圆盘 + 按方向锥开口的人行道环"，问题在于圆盘半径与条带宽窄无关，
 * 圆盘一斜插进两条夹角不大的路就会在中间留出楔形缺口（截图里路口四角那些三角地）。
 *
 * 现在按真实的转角几何拼：绕路口走一圈，每条臂铺到它的收口线，两臂之间用
 * 路缘转角圆弧收边；人行道则补在"转角圆弧外侧到红线"的那一小块街角里。
 */
function junctionSurfaces(j: Junction, ji: number, g: JunctionGeom | null): SurfaceFeature[] {
  if (j.arms.length < 3 || !g) return [];
  const out: SurfaceFeature[] = [];
  const { arms, corners } = g;

  // 以路口中心为扇心拆成三角面：收口距离被钳得很短时这个多边形会自交，
  // 而三角面永远合法。
  // 整片能一次给出就一次给出 —— 扇形三角面之间的接缝会在沥青上留下一圈
  // 放射状的细线（每个面各填各的，抗锯齿在公共边上留一道缝）。
  if (g.ring) {
    out.push({
      name: `junc_${ji}_road`,
      group: 'road/junction',
      ring: toCCW(g.ring),
      mat: 'asphalt',
      y: Y_ROAD + 0.0016 + ji * 1e-6,
    });
  } else {
    // 收口多边形自交 —— 急角 Y 口（两臂夹角 40° 出头）、以及合并路口里
    // 两条臂几乎同向（0.4°）时都会这样。
    //
    // 旧实现是以路口中心为扇心把整圈点扇形三角化。那个扇形在数学上等于
    // "半径 = pad 的圆盘"，急角路口会糊出一块 400~600 m² 的沥青广场
    // （用户截图里那团最扎眼的黑）；而且它比真实十字范围大一整圈，
    // 把人行道、斑马线全压在下面。
    //
    // 正确形状 = 各条臂的喉部矩形之并。并集永远合法，也永远不超出
    // 真实的路口范围；急角处留下尖角而不是圆盘，这正是实际路口的样子。
    const rects: [number, number][][][] = [];
    for (const a of arms) {
      if (a.pad < 1e-6) continue;
      rects.push([armThroat(a).map((p) => [p.x, p.y] as [number, number])]);
    }
    let merged: [number, number][][][] = [];
    try {
      if (rects.length === 1) merged = rects;
      else if (rects.length > 1) {
        merged = polygonClipping.union(
          rects[0] as unknown as Parameters<typeof polygonClipping.union>[0],
          ...(rects.slice(1) as unknown as Parameters<typeof polygonClipping.union>[0][])
        ) as unknown as [number, number][][][];
      }
    } catch {
      merged = rects;
    }
    merged.forEach((poly, k) => {
      const ext = poly[0];
      if (!ext || ext.length < 3) return;
      let ring = ext.map(([x, y]) => new Pt(x, y));
      // polygon-clipping 的交并差都把环首点又抄一遍到末尾；并集在矩形相接处
      // 还会留下相距 1e-3 的重复点。两者都会变成零长边，`isSimpleRing` 直接判负
      // （测试里"铺装不自交"就是这么挂的），所以统一按 2 cm 去重。
      ring = dedupeRing(ring, 0.02);
      if (ring.length < 3) return;
      out.push({
        name: `junc_${ji}_road${k ? `_${k}` : ''}`,
        group: 'road/junction',
        ring: toCCW(ring),
        mat: 'asphalt',
        y: Y_ROAD + 0.0016 + ji * 1e-6,
      });
    });
  }

  // ---- 街角铺装：先铺一圈绿化带（到 sw+vg），再在上面叠一圈人行道（到 sw），
  // 露出来的一窄条就是转过街角的绿篱带 —— 和直路段上的绿化带接得上。
  for (let k = 0; k < arms.length; k++) {
    const c = corners[k];
    if (!c) continue;
    const a = arms[k];
    const b = arms[(k + 1) % arms.length];
    const wA = a.swL + a.vgL;
    const wB = b.swR + b.vgR;
    if (wA < 1e-3 && wB < 1e-3) continue;

    // 有绿化带才单独铺一层：铺到 sw+vg，人行道再盖在上面，露出来的一窄条
    // 就是转过街角的绿篱带，和直路段上的绿化带接得上。
    if (wA - a.swL > 1e-3 || wB - b.swR > 1e-3) {
      const raw = cornerPaving(c, j.center, a, b, wA, wB);
      const ring = raw ? clipOffCarriageway(raw, j) : null;
      if (ring) {
        out.push({
          name: `junc_${ji}_verge_${k}`,
          group: 'road/verge',
          ring: toCCW(ring),
          mat: 'grass',
          y: Y_VERGE + 0.0016,
        });
      }
    }
    const rawWalk = cornerPaving(c, j.center, a, b, a.swL, b.swR);
    const walk = rawWalk ? clipOffCarriageway(rawWalk, j) : null;
    if (walk) {
      out.push({
        name: `junc_${ji}_corner_${k}`,
        group: 'road/sidewalk',
        ring: toCCW(walk),
        mat: 'concrete',
        y: Y_WALK + 0.0016,
      });
    }
  }

  return out;
}

/** 去掉相邻重复点（转角处的贝塞尔端点与切点重合） */
function dedupeRing(ring: Pt[], eps = 1e-4): Pt[] {
  const out: Pt[] = [];
  for (const p of ring) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(l.x - p.x, l.y - p.y) > eps) out.push(p);
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= eps) out.pop();
  }
  return out;
}

export { Y_ROAD, Y_WALK, Y_VERGE };
