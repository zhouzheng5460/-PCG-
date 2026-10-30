// 方向控制线（FieldGuide）：用户在 2D 图上画的一条折线，
// 意思是"附近的街道 / 街区朝向沿着我画的这个方向走"。
//
// 这是张量场唯一需要用户直接操作的东西 —— 用户不需要理解张量，
// 只要画一条"我想让街道顺着走"的线。内部转成一个 `path` 场源，
// 权重随到折线的距离高斯衰减，于是只影响线两侧一个带内。

import { Pt } from '../core/geom';
import type { FieldSource } from './field/tensor';

export interface FieldGuide {
  id: string;
  label: string;
  enabled: boolean;
  /** 折线，至少两个点 */
  pts: Pt[];
  /** 0~1：越大越能压住全局基准方向 */
  strength: number;
}

export function makeGuide(id: string, label: string, pts: Pt[], strength = 0.8): FieldGuide {
  return { id, label, enabled: true, pts: pts.slice(), strength };
}

/**
 * 转成场源。
 *
 * 影响半径取城市半径的 0.26（约 3 个街区宽），线外迅速退回全局方向。
 *
 * 强度为什么是 5 倍而不是 1.5 倍：
 * 张量场是在 2θ 空间做加权平均的，两个方向合成后的角差会被"折半"。
 * 实测（基准方向 57.6°、线 18°）：权重 1.2 : 0.9 时场只转到 32.5°，
 * 权重比 9 : 1 时还有 2.7° 残差 —— 强度不够时用户会觉得"线画了没反应"。
 * 5 倍（默认 strength 0.8 → 权重 4.0，约 4.4 : 1）能把残差压到 5° 以内，
 * 同时保留指数衰减的过渡带，不会在线的边缘硬切一刀。
 */
export function guideToSource(g: FieldGuide, cityRadius: number): FieldSource {
  return {
    id: g.id,
    type: 'path',
    path: g.pts,
    radius: Math.max(8, cityRadius * 0.26),
    strength: Math.max(0.15, g.strength) * 5,
    falloff: 1.6,
  };
}

/** 折线是否够长（太短的点一下就被当成误触） */
export function guideIsUsable(pts: Pt[], minLength = 8): boolean {
  if (pts.length < 2) return false;
  let len = 0;
  for (let i = 0; i + 1 < pts.length; i++) len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  return len >= minLength;
}
