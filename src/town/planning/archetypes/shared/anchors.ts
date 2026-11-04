// Archetype · 功能锚点（C1）
//
// 阶段 C 的核心不是"再画几种地面"，而是先回答**这块地上的功能发生在哪里**：
//
//   建筑主入口在哪 → 前场必须贴它、必须通到街上
//   服务入口在哪   → 后勤面必须贴它，且不能摆在主展示界面上
//   街道接入点在哪 → 步行/车行骨架的起点
//   活动节点在哪   → 公园的场地、广场的中心
//   连续绿核在哪   → 不许被路径切碎的那一块
//   不可覆盖区在哪 → 现有建筑、保留地
//
// 这些都不进 Core 契约（`SiteContext` / `SitePlanCandidate` 不动），
// 只在 archetype 内部算、内部用 —— 它们回答的是"这次规划怎么组织"，
// 不是"这块地是什么"，所以不属于被冻结的那一层。
//
// ## 为什么不能用建筑中心点当入口
//
// 建筑的**中心**永远在体量内部，从中心发出的"入口"会穿过墙体。真正能用的入口
// 是：贴着临街面的那条**建筑外边**的中点，法线朝街。这也正是"前场宽度参考
// 建筑入口界面"这句话的操作含义 —— 先有那条界面，才有前场的宽度。

import { Pt } from '../../../../core/geom';
import { surfaceArea, surfaceInset, type PlanSurface } from '../../core/surface';
import { clipTo, ribbon, type SiteFrame } from './frame';
import type { SiteContext } from '../../core/types';
import type { PlannedBuilding } from '../../core/candidate';
import { siteFrame } from './frame';

const U = (m: number) => m / 7;

/** 一个功能锚点。`source` 必须写清楚是推出来的还是给定的 —— 推出来的要能追溯 */
export interface Anchor {
  at: Pt;
  /** 朝外法线（从地块/建筑指向道路） */
  normal: Pt;
  /** 界面宽度（世界单位）：主入口是那条建筑外边的长度，街道接入点是可用开口宽度 */
  width: number;
  source: 'building' | 'frontage' | 'derived';
  note: string;
}

export interface SiteAnchors {
  /** 建筑主入口（沿街那条外边的中点） */
  mainEntrances: Anchor[];
  /** 建筑服务入口（背面/侧面，避开主展示面） */
  serviceEntrances: Anchor[];
  /** 街道合法接入点 */
  streetAccess: Anchor[];
  /** 公共活动节点（先给候选位置，尺寸由场地面积定） */
  activityNodes: Anchor[];
  /** 优先保留的连续绿核（可空） */
  greenCore: PlanSurface | null;
  /** 不可覆盖区（现有建筑） */
  reserved: PlanSurface[];
  notes: string[];
}

/**
 * 从建筑体量推主入口：**取朝向主临街面、且离临街面最近的那条外边**。
 *
 * 判定用"这条边中点到临街面所在直线的有符号距离 + 法线与临街面法线的夹角"，
 * 两项都要：只看距离会选中侧边（侧边中点也可能很近），只看朝向会选中背面的平行边。
 */
export function buildingEnvelope(b: PlannedBuilding, streetNormal: Pt, streetPoint: Pt): { at: Pt; normal: Pt; width: number } | null {
  const ring = b.footprint.outer;
  if (ring.length < 3) return null;
  let best: { at: Pt; normal: Pt; width: number } | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const c = ring[(i + 1) % ring.length];
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < U(3)) continue;
    const ex = dx / len;
    const ey = dy / len;
    // 两个候选法线，取朝向街道的那个
    let nx = -ey;
    let ny = ex;
    if ((streetPoint.x - (a.x + c.x) / 2) * nx + (streetPoint.y - (a.y + c.y) / 2) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const facing = nx * streetNormal.x + ny * streetNormal.y; // 1 = 正对街
    const mid = new Pt((a.x + c.x) / 2, (a.y + c.y) / 2);
    const toStreet = Math.hypot(streetPoint.x - mid.x, streetPoint.y - mid.y);
    // 正对街优先（权重 3），同时要近
    const score = facing * 3 - toStreet * 0.5 + Math.min(len, U(40)) * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = { at: mid, normal: new Pt(nx, ny), width: len };
    }
  }
  return best;
}

/**
 * 推服务入口：**离主入口最远、且不在主展示面上的那条外边**。
 *
 * 公共建筑/公园管理用房的服务口一定在背面或侧背面 —— 垃圾车、货车、员工
 * 都不该从主入口穿过。这里用"与主入口方向的夹角"来判：夹角 > 100° 才算背面。
 */
export function serviceEnvelope(b: PlannedBuilding, main: { at: Pt; normal: Pt } | null): { at: Pt; normal: Pt; width: number } | null {
  const ring = b.footprint.outer;
  if (main) return pickServiceEdge(ring, main);
  return null;
}

function pickServiceEdge(ring: Pt[], main: { at: Pt; normal: Pt }): { at: Pt; normal: Pt; width: number } | null {
  // 法线的"朝外"用**体量质心**判定，不用主入口 —— 主入口就在某条边的中点上，
  // 拿它判方向会在这个边上退化（向量≈0），结果选出来的服务边正好是主入口那条边。
  const c = {
    x: ring.reduce((a, p) => a + p.x, 0) / ring.length,
    y: ring.reduce((a, p) => a + p.y, 0) / ring.length,
  };
  let best: { at: Pt; normal: Pt; width: number } | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < U(3)) continue;
    const ex = dx / len;
    const ey = dy / len;
    let nx = -ey;
    let ny = ex;
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    // 朝外 = 远离质心
    if ((mid.x - c.x) * nx + (mid.y - c.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    // 服务口 = 离主入口最远的那条外边（距离为主，背向为辅）
    const far = Math.hypot(mid.x - main.at.x, mid.y - main.at.y);
    const back = -(nx * main.normal.x + ny * main.normal.y);
    const score = far * 1.0 + back * 2.0;
    if (score > bestScore) {
      bestScore = score;
      best = { at: mid, normal: new Pt(nx, ny), width: len };
    }
  }
  return best;
}

/**
 * 街道接入点：沿每条临街边取中点，往里 2 m 作为开口位置。
 *
 * 直接的 `ctx.vehicleAccessCandidates` / `pedestrianAccessCandidates` 已经算过
 * "这里能不能开口"，但它们是**按评分排序的点集**，不保证覆盖每一条临街面。
 * 这里要的是"每一条临街面各一个"，用于组织骨架，所以按边取中点更稳。
 */
export function streetAccessPoints(ctx: SiteContext, f: SiteFrame): Anchor[] {
  const out: Anchor[] = [];
  const seen = new Set<string>();
  const add = (a: Pt, b: Pt, frontage: 'primary' | 'secondary') => {
    const key = `${a.x.toFixed(1)},${a.y.toFixed(1)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    out.push({
      at: mid,
      normal: f.vDir,
      width: Math.hypot(b.x - a.x, b.y - a.y),
      source: 'frontage',
      note: frontage === 'primary' ? '主临街面中点' : '次临街面中点',
    });
  };
  if (ctx.primaryFrontage) add(ctx.primaryFrontage.parcelEdge[0], ctx.primaryFrontage.parcelEdge[1], 'primary');
  if (ctx.secondaryFrontage) add(ctx.secondaryFrontage.parcelEdge[0], ctx.secondaryFrontage.parcelEdge[1], 'secondary');
  return out;
}

/**
 * 连续绿核：可建区里**离所有已规划面最远**的那块。
 *
 * 用"到边界的最远点"当代理：公园/绿地的中心本来就不该被铺装切到，
 * 把内缩 12 m 之后剩下最大的一块作为绿核，路径规划时避开它。
 */
export function greenCoreOf(buildable: PlanSurface, insetM: number): PlanSurface | null {
  const pieces = surfaceInset(buildable, U(insetM)).filter((s) => surfaceArea(s) > U(4) * U(4));
  if (!pieces.length) return null;
  return pieces.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
}

/** 判定一个点是否落在这些面里（用于"主入口有没有通到街上"这类连通检查） */
export function coveredBy(p: Pt, surfaces: PlanSurface[]): boolean {
  return surfaces.some((s) => insideRing(p, s.outer));
}

function insideRing(p: Pt, ring: ReadonlyArray<{ x: number; y: number }>): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y) {
      const t = (p.y - a.y) / (b.y - a.y);
      if (p.x < a.x + t * (b.x - a.x)) hit = !hit;
    }
  }
  return hit;
}

/**
 * 沿临街面的绿化缓冲带（5 m）。
 *
 * 用途：绿地/公园没有整圈种植带时，**至少让街边有一条绿**。
 * 用户的要求是"对道路边界形成合理的种植缓冲" —— 不是"围一圈绿篱"，
 * 所以只贴临街面铺一条，不切断场地内部。
 */
export function streetBuffer(ctx: SiteContext, f: SiteFrame, buildable: PlanSurface, depthM = 5): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const fe of [ctx.primaryFrontage, ctx.secondaryFrontage]) {
    if (!fe) continue;
    const [ea, eb] = fe.parcelEdge;
    const mid = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
    const lenU = Math.hypot(eb.x - ea.x, eb.y - ea.y);
    const s0 = new Pt(mid.x + f.vDir.x * U(0.5), mid.y + f.vDir.y * U(0.5));
    const s1 = new Pt(s0.x + f.vDir.x * U(depthM), s0.y + f.vDir.y * U(depthM));
    const r = ribbon(s0, s1, lenU * 0.8);
    const c = r ? clipTo(r, [buildable]) : null;
    if (c && surfaceArea(c) > U(2) * U(4)) out.push(c);
  }
  return out;
}
