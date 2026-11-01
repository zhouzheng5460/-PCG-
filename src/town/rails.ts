// 栏杆与绿篱：把「一段线性要素」拆成真实构件。
//
// 为什么需要这一层
// ----------------
// 原来"围栏"是一条带高度的 path，而 `build3d` 对带高度的 path 一律调
// `wallSolid` —— 于是围栏在三维里是**一堵实心矮墙**。俯视图完全看不出问题
// （2D 只画一条线），一进三维就露馅：参考图里的栏杆是"两根横杆 + 一排立柱"
// 的通透构件，行人能看穿、车过不去。绿篱同理，参考图是"一段段分开的矮方块"，
// 不是一条连续绿带。
//
// 所以这里把它们拆成两种要素：
//   · 横杆 → 细 path，靠 y（底面高度）+ height（截面厚度）悬在半空
//   · 立柱 → post 道具，沿间距布一排
//   · 绿篱 → 分段 hedge 道具，块与块之间留缝
// 拆分后 2D 仍是一条线（甚至更好看：只画上横杆），3D / GLB 才是真的栏杆。
//
// 所有量按米给，进函数内部换成世界单位（1 单位 ≈ 7 m，见 road/spec.ts 的 u()）。

import { Pt } from '../core/geom';
import type { PathFeature, PropFeature } from '../scene/types';
import type { MatKey } from '../scene/palette';
import { u } from '../road/spec';

/** post 道具的基准高度（米）。scale 是相对它的倍率。 */
export const POST_BASE_H_M = 1.1;

export interface RailSpec {
  /** 栏杆总高（米） */
  heightM: number;
  /** 上横杆中心离地高（米） */
  topBarM: number;
  /** 下横杆中心离地高（米）；给 0 就只要一根 */
  lowBarM: number;
  /** 横杆截面边长（米） */
  barM: number;
  /** 立柱间距（米） */
  postPitchM: number;
  /** 立柱截面边长（米），实际由 props.ts 里的 post 决定，这里只用于说明 */
  postM: number;
  mat: MatKey;
}

/** 人行道护栏：1.1 m 高，双横杆，立柱 2.2 m 一根 —— 参考图的口径 */
export const RAIL_WALK: RailSpec = {
  heightM: 1.1,
  topBarM: 1.0,
  lowBarM: 0.52,
  barM: 0.05,
  postPitchM: 2.2,
  postM: 0.06,
  mat: 'fence',
};

/** 停车场围栏：比人行道护栏矮一点点、柱距更疏，属于"圈地"而不是"防穿越" */
export const RAIL_PARK: RailSpec = {
  heightM: 1.35,
  topBarM: 1.26,
  lowBarM: 0.24,
  barM: 0.055,
  postPitchM: 2.6,
  postM: 0.07,
  mat: 'fence',
};

/**
 * 沿折线按固定弧长取点（含起点）。用来布立柱。
 *
 * **末端必须收一根柱**：杆长很少正好是柱距的整数倍（一段护栏 2.6 m、柱距 2.2 m，
 * 只按 pitch 摆就只有起点一根柱），末尾一段双横杆悬空 —— 三维里读成"栏杆缺了
 * 一根竖杆"，用户截图里圈的就是这个缺口。所以只要末端离最后一根柱超过
 * 0.15 m（约 1 m），就在**折线的终点**补一根，让每段栏杆都是闭合的框。
 */
function postsAlong(pts: Pt[], pitch: number): Pt[] {
  const out: Pt[] = [];
  if (pts.length < 2 || pitch <= 1e-9) return out;
  let acc = 0;
  let next = 0;
  let lastAcc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    while (next <= acc + L + 1e-9) {
      const t = (next - acc) / L;
      out.push(new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
      lastAcc = next;
      next += pitch;
    }
    acc += L;
  }
  if (lastAcc > 0 || out.length === 0) {
    if (acc - lastAcc > pitch * 0.14) out.push(pts[pts.length - 1]);
  }
  return out;
}

/**
 * 沿折线生成一段栏杆：两根悬空横杆 + 一排立柱。
 *
 * `y` 是地面标高（世界单位），横杆挂在它上方。
 * 下横杆标 `hidden2d`：两条横杆在俯视图里完全重合，画两遍只会让线变粗、
 * 白白多吃一次描边开销。
 */
export function addRail(o: {
  pts: Pt[];
  namePrefix: string;
  group: string;
  y: number;
  spec: RailSpec;
  paths: PathFeature[];
  props: PropFeature[];
}): void {
  const { pts, spec } = o;
  if (pts.length < 2) return;
  const barThick = u(spec.barM);
  const bars = [spec.topBarM, spec.lowBarM].filter((h) => h > 0);

  bars.forEach((hM, k) => {
    o.paths.push({
      name: `${o.namePrefix}_bar${k}`,
      group: o.group,
      pts,
      width: barThick,
      mat: spec.mat,
      // 底面 = 中心高 − 半个截面，这样杆的**中心**正好落在指定高度
      y: o.y + u(hM) - barThick / 2,
      height: barThick,
      hidden2d: k > 0,
    });
  });

  const posts = postsAlong(pts, u(spec.postPitchM));
  for (let i = 0; i < posts.length; i++) {
    o.props.push({
      name: `${o.namePrefix}_post${i}`,
      group: o.group,
      kind: 'post',
      at: posts[i],
      rot: 0,
      scale: spec.heightM / POST_BASE_H_M,
      seed: (i * 7919) % 9999,
    });
  }
}

export interface HedgeSpec {
  /** 单块长度（米） */
  blockM: number;
  /** 块间留缝（米） */
  gapM: number;
  /** 高度（米） */
  heightM: number;
  /** 进深（米） */
  widthM: number;
}

/**
 * 绿篱：参考图里"一排分开的方块"，块与块之间必须留缝才读得出是绿篱。
 *
 * 高度按用户口径抬到 **1.1 m，与栏杆齐平**（原来 0.45 m，站在 1.1 m 的栏杆旁边
 * 矮一头，读起来是"草皮"不是"绿篱"）。平面尺寸不变（1.5 × 0.9 m）——
 * 高度单独缩放（见 `PropFeature.hz`），否则等比放大后一块绿篱宽 2.2 m，
 * 直接顶掉半条人行道。
 */
export const HEDGE_LOW: HedgeSpec = { blockM: 1.5, gapM: 0.35, heightM: 1.1, widthM: 0.9 };

/**
 * 沿折线铺一条低矮绿篱。
 *
 * 分块而不是拉一条连续的条带：连续条带在三维里读成"绿色矮墙"，
 * 断开之后才有"一丛一丛修剪过的灌木"的观感 —— 也就是参考图里那种。
 */
export function addHedgeRun(o: {
  pts: Pt[];
  namePrefix: string;
  group: string;
  spec?: HedgeSpec;
  props: PropFeature[];
}): void {
  const spec = o.spec ?? HEDGE_LOW;
  const { pts } = o;
  if (pts.length < 2) return;
  const pitch = u(spec.blockM + spec.gapM);
  const block = u(spec.blockM);
  if (pitch < 1e-6) return;

  let acc = 0;
  let next = 0;
  let k = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    while (next + block <= acc + L + 1e-9) {
      const t = (next - acc) / L;
      const at = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      o.props.push({
        name: `${o.namePrefix}_h${k++}`,
        group: o.group,
        kind: 'hedge',
        at,
        rot: ang,
        // `scale` 只管**平面**尺寸（基准块 1.5 m 长 / 0.9 m 宽），
        // 高度走 `hz` 单独缩放 —— 否则想长到 1.1 m 高就得把宽度一起放大 2.4 倍。
        scale: spec.widthM / 0.9,
        hz: spec.heightM / 0.45,
        seed: (k * 6151) % 9999,
      });
      next += pitch;
    }
    acc += L;
  }
}
