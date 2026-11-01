// 城市参数：把散在 modern.ts / parking.ts 里的"魔法数字"收成一份可调、可校验的对象。
//
// 三条规矩（照着做，后面几层才不会互相打架）：
//   1. **单一来源**。参数只在这里定义默认值和合法区间，别处一律读 `model.params`。
//   2. **有界**。每个参数都有 min/max，`resolveParams()` 负责钳制 ——
//      面板上写错一位数不该让整城生成崩掉（比如 cellM = 0.5 会切出几万个小格）。
//   3. **街道断面不进来**。路宽和车道数、最小红线、路口圆角是一组耦合量，
//      由 `src/road/spec.ts` 的规范表统一管（`minRedLine` 是"圆角不被压坏"的下限）。
//      把它做成自由滑杆，改一格就会让六车道挤掉人行道 —— 上一轮已经踩过。
//      用户能调的是"哪一种断面"，不是"断面里每个数字"。

import type { ParkLevel } from './parking';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * 地块切分模式。
 *
 *   · ortho 正交网格：按「沿街面宽 × 进深」切成网格，每块都有临街边（城市的底子）
 *   · diag  斜切：相对街区主轴偏 45° 起刀（斜向街坊）
 *   · free  自由：每刀 ±20° 抖动，出现楔形 / 不规则地块
 *   · field 跟随街区：刀锋跟着**街区自身最长的那条边**走，
 *           斜街区 / 变形街区里地块边界不会跟街道打架
 *
 * 已移除的两个模式（用户核对意见）：
 *   · `strip` 平行条带 —— 同向连切只会切出"一条贯通全街区的窄条"，
 *     进深动辄 60~90 m，退线后就是一栋超长的薄楼，这是错的。真实地块
 *     的窄边是**沿街面宽**，另一向必须按进深限制再切一刀（现在 ortho 就是这么做的）。
 *   · `field` 旧版"每刀重采样城市张量场" —— 地块边界跟着场转，可场在街区
 *     内部是虚的（X 型退化节点），采出来的方向常与街区四边斜交，
 *     于是内部巷道斜穿街区、建筑也被掰成斜的平行四边形。现在 `field`
 *     不再采样场，只取"街区最长边"这一个稳定的方向。
 *
 * 定义放在这里（而不是 modern.ts）是因为三处都要用它：
 * 参数面板按比重分配、选中地块单块指定、链接快照序列化。
 */
export type ParcelPattern = 'ortho' | 'diag' | 'free' | 'field';

/** 四种模式的权重。**相对值**：全 0 时退回 ortho */
export type ParcelPatternWeights = Record<ParcelPattern, number>;

/**
 * 模式的展示元信息（面板 / 图例共用）。
 *
 * `desc` 不是装饰：几种切法在空中读起来差别没那么大，用户调完滑杆不知道
 * 自己看的是什么，所以每条都得说清"这个模式切出来长什么样"。
 */
export const PARCEL_PATTERN_META: { key: ParcelPattern; label: string; desc: string }[] = [
  { key: 'ortho', label: '正交网格', desc: '严格沿街区主轴等分，尺规方格' },
  { key: 'field', label: '跟随街区', desc: '沿主轴但切点抖动，进深更浅，肌理碎' },
  { key: 'diag', label: '斜切', desc: '相对街区主轴偏 45° 起刀' },
  { key: 'free', label: '自由', desc: '切点抖动 ±30°，不规则地块' },
];

/** 默认比重：正交占底子，斜切与跟随街区各一份，剩一点给不规则 */
export const DEFAULT_PARCEL_PATTERNS: ParcelPatternWeights = {
  ortho: 0.46,
  diag: 0.18,
  free: 0.12,
  field: 0.24,
};

/** 是不是一个合法的切分模式（解析分享链接时用，坏值一律忽略而不是崩） */
export function isParcelPattern(v: unknown): v is ParcelPattern {
  return typeof v === 'string' && PARCEL_PATTERN_META.some((m) => m.key === v);
}

/**
 * 比重数组归一化后的百分比（整数，和恒为 100）。
 *
 * 面板要显示"实际会按这个比例分配"，而权重本身是相对值 —— 用户把正交拖到
 * 0.5 时，真正读的是"占四成"还是"占八成"。全 0 时退回 ortho 100%。
 */
export function patternPercents(w: ParcelPatternWeights): Record<ParcelPattern, number> {
  const keys = PARCEL_PATTERN_META.map((m) => m.key);
  const total = keys.reduce((s, k) => s + Math.max(0, w[k] ?? 0), 0);
  if (!(total > 0)) return { ortho: 100, diag: 0, free: 0, field: 0 };
  // 先按比例取整，再把差额补给最大的一项 —— 避免 33/33/33 这种和不等于 100
  const raw = keys.map((k) => (Math.max(0, w[k] ?? 0) / total) * 100);
  const out = raw.map((v) => Math.floor(v));
  let rest = 100 - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i] as [number, number]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    out[i]++;
    rest--;
  }
  const res: Record<ParcelPattern, number> = { ortho: 0, diag: 0, free: 0, field: 0 };
  keys.forEach((k, i) => {
    res[k] = out[i];
  });
  return res;
}

/** 街坊 / 地块（parcel）形态 —— 决定"楼和楼之间留多少空" */
export interface BlockParams {
  /** 一个开发单元（一栋楼）的边长，米。调小 → 楼更碎、栋数更多 */
  cellM: number;
  /** 相邻两栋楼之间的缝宽，米。调大 → 覆盖率下降 */
  gapM: number;
  /** 建筑退线系数：退线 = 地块边长 × 该系数，结果夹在 0.12~0.38 世界单位 */
  setbackK: number;
  /** 地块（parcel）目标面积，单位²（1 单位² = 49 m²）。越大 → 切得越粗 */
  parcelTargetA: number;
  /**
   * 普通街区是否**切成小地块**（parcelize）。
   *
   * 关：一个街区 = 一个用途 = 一次规划，出来是一整块硬质上一栋大楼
   *     （塔楼 + 裙房 + 副楼咬成一片巨型屋顶，绿地只剩沿路 1.3 m 收边，
   *      实测全城绿地占比 6.4%）。
   * 开：街区先按 `parcelPitchM` 做一次张量分割，每个地块单独排一栋楼；
   *     基底铺草坪、分割线铺窄混凝土巷 —— 这才是"院落 + 小楼"的城市肌理。
   */
  parcelize: boolean;
  /**
   * 小地块的**沿街面宽**，米。调小 → 地块更窄、沿街切得更碎。
   *
   * 这是决定"沿街切几块"的唯一参数：切分先按面宽在沿街方向排布，
   * 进深超过 `PARCEL_DEPTH_M` 时再横切一刀。地块面积于是变成
   * 「面宽 × 进深」的结果，而不是一个被反推出来的面积目标。
   *
   * 为什么以面宽为准（用户核对意见）：地块划分的真实依据就是面宽 ——
   * 沿街 20~35 m 一块，进深 30~45 m。反过来按面积定目标，同样 40 单位²
   * 的地块可以是 22×22 m，也可以是 60×7 m 的窄条，后者退线完就是一栋
   * 超长的薄楼。面宽定死之后，这个形状陷阱从源头消失。
   *
   * 街区中位 74 m 见方时：面宽 26 m → 每边 3 块，一个街区 6~9 块地。
   */
  parcelPitchM: number;
  /** 一级分割线（贯通子街坊）铺的沥青服务车道宽度，米 */
  seamWideM: number;
  /**
   * 地块切分的**模式权重**：正交网格 / 斜切 / 自由 / 跟随街区。
   *
   * 每个街区按这里的**比重**抽一种模式：
   *   · ortho  正交网格（默认肌理：按沿街面宽 × 进深切）
   *   · diag   斜切（相对街区主轴旋转 45° 起刀，之后正交）
   *   · free   自由（每刀 ±20° 抖动，出现不规则地块）
   *   · field  跟随街区（刀锋跟着街区最长边走，斜街区里不跟街道打架）
   * 权重是相对的，全填 0 会退回 ortho。
   */
  parcelPatterns: ParcelPatternWeights;
  /** 二级分割线（地块之间）铺的混凝土巷道宽度，米 */
  seamNarrowM: number;
  /** 地块内部主路（接外部道路那条）的车行道宽，米 */
  internalRoadW: number;
  /** 地块内部路网怎么长：张量主轴直切 / 栅格 A* 寻路 */
  internalRoads: 'tensor' | 'path';
  /** A* 栅格边长，米。越小路越顺，代价是状态数按平方涨 */
  pathCellM: number;
  /** A* 转弯惩罚，单位是"走一格"的倍数。调大 → 更爱长直线 */
  pathTurn: number;
  /** A* 单格代价的随机扰动幅度 0~0.6，让每次生成的路不一样 */
  pathJitter: number;

  // ---------------- 道路密度 / 街区内环路
  //
  // 全城路网是"张量场追流线 + 布尔切面"硬解出来的：每个街区边界都是一条城市路。
  // 街区一小，路就占掉 30% 以上的地（实测 30.8% 沥青 + 7.8% 人行道），
  // 而每条路上还都配齐了人行道、绿化带、斑马线 —— 看着就是"路比楼多"。
  //
  // 正确的做法不是继续在小尺度的路网上修修补补，而是**把街区放大**，
  // 让服务街区的那部分路退出"城市路网"，变成地块内部的环路（小区路 / 园区路）：
  // 断面窄、没有斑马线、不参与路口求解，视觉上退到背景里去。

  /** 街区尺度系数：城市道路间距 = 基准间距 × 该系数。调大 → 街区更大、城市路更少 */
  spacingK: number;
  /**
   * 禁建区是否**只铺一块硬地**（用户在这里放自己的模型）。
   *
   * 开：禁建区里不排任何城市内容 —— 没有建筑、没有内部路、没有地块分割，
   *     只有一条红线内收后的沥青地面 + 围栏。
   * 关：回到旧的"封闭街区"管线（内部路 + 二次张量分割 + 建筑 + 绿地/停车预算）。
   */
  zonePad: boolean;
  /** 大块地内部是否绕建筑铺一圈服务环路 */
  serviceLoop: boolean;
  /** 环路车行道宽，米 */
  loopW: number;
  /** 环路与红线之间那条带（绿化 / 访客停车）的宽度，米 */
  loopVergeM: number;
  /** 触发环路的最小地块跨度，米。小于它的地块按原样规划 */
  loopMinM: number;
  /**
   * 禁建区**避障**：路网从禁区旁边让开，而不是被掰成与禁区平行、一路铺到红线上。
   *
   * 开：禁区不参与方向场合成，只在流线追踪阶段当几何障碍 ——
   *     进到禁区里的那一段流线直接剪掉，贴边不足让距的点沿外法线推到让距线上
   *     （见 field/obstacle.ts），种子也不撒进禁区里。禁区轮廓本身不再是道路。
   *     结果是：路走到禁区跟前就**直着让开**，边上留一条干净的隔离带。
   * 关：退回旧做法（禁区边延长成方向源，街道与禁区平行、紧贴红线）。
   */
  zoneAvoid: boolean;
  /** 避障让距，米：路网到禁区轮廓的最小距离（这段地是绿化隔离带） */
  zoneAvoidPadM: number;
  /**
   * 禁区**弧线**绕障（实验，默认关）。
   *
   * 关（默认）：路到禁区跟前就**直着让开** —— 进禁区的段剪掉、贴边不足让距的
   *   点沿外法线推到让距线上。路是直的，禁区边上留一条清清楚楚的隔离带。
   *
   * 开：在场里加一个"势流绕障"偏转（field/deflect.ts），流线像水绕石头一样
   *   弯着绕过去、彼此保持间距。观感上更"自然"，但街道会整体带上一段弧度，
   *   且长条禁区两端容易堆出两条贴得很近的平行街，所以默认不启用。
   */
  zoneAvoidBend: boolean;
}

/** 建筑体型 —— 高度、塔楼比例、合并成板楼的比例 */
export interface BuildingParams {
  /** 外围区的塔楼比例 0~1 */
  towerChance: number;
  /** 中心区的塔楼比例 0~1（`tightRadius` 以内算中心） */
  towerChanceCore: number;
  /** 裙房高度区间，世界单位（1 单位 ≈ 7 m） */
  podiumHMin: number;
  podiumHMax: number;
  /** 塔身高度区间（中心 / 外围），世界单位；实际还会被塔身宽度封顶 */
  towerHMin: number;
  towerHMaxCore: number;
  towerHMaxEdge: number;
  /** 板楼高度区间，世界单位 */
  slabHMin: number;
  slabHMax: number;
  /** 相邻两格合并成一栋长板楼的比例 0~1 */
  mergeChance: number;
  /** "中心区"的判定半径（占城市半径的比例） */
  tightRadius: number;
  /**
   * 楼栋之间的净距，米（参考图里住宅楼间距 12~18 m）。
   *
   * 这是"一个地块里排几栋平行板楼"这条新规则的间距旋钮：
   * 间距越大，院子越宽、楼越少；间距 0 会让几栋楼贴成一整片墙。
   */
  spacingM: number;
  /**
   * 连续裙房的进深，米（0 = 不生成裙房）。
   *
   * 商业 / 商务 / 市政地块的"塔楼 + 裙房 + 内院"三段式里，裙房是沿地块四边
   * 围合的低层带（商业界面），厚度就是这个数。设 0 就退回"一栋楼居中"。
   */
  podiumDepthM: number;
  /**
   * 用"塔楼 + 连续裙房 + 内院"三段式的概率（0~1）。
   *
   * 用户口径：三分式只当**样式选项**随机用一点，不做全城主调 ——
   * 原来 85% 还是原来的"一地块一栋 / 多栋板楼"，15% 才起裙房。
   */
  podiumChance: number;
  /**
   * 一个地块最多排几栋楼。
   *
   * 1 = 回到旧口径（一个地块一栋楼）；2~4 才是参考图里的"多栋平行板楼 + 内院"。
   */
  maxPerParcel: number;
}

/** 绿地 / 树木 */
export interface GreenParams {
  /** 林地密度：每 1000 m² 的树数 */
  treeDensity: number;
  /** 树簇尺度，米：越大越成片，越小越零散 */
  clusterScale: number;
  /** 边界羽化宽度，米：靠近区域边界处密度按这个宽度渐降 */
  edgeFeather: number;
  /** 灌木占比 0~1 */
  shrubRatio: number;
  /** 针叶占比 0~1 */
  pineRatio: number;
}

export interface TownParams {
  block: BlockParams;
  building: BuildingParams;
  green: GreenParams;
}

export function defaultParams(): TownParams {
  return {
    block: {
      cellM: 20,
      gapM: 1.0,
      setbackK: 0.036,
      parcelTargetA: 60,
      // 小地块：默认开。
      //
      // 「沿街面宽 26 m」是一个街区切几块的唯一旋钮：街区中位 74 m 见方时，
      // 沿街 74/26 ≈ 3 块，进深再按 45 m 横切一刀 → 一个街区 6 块地，
      // 每块 26×37 m（≈960 m²），退线完是"楼 20×18 m + 一圈院子"，
      // 覆盖率 40% 上下 —— 住宅地块的常见尺度。
      // 21 m 会切到 9 块（院子比楼大），34 m 只剩 4 块（地块过大）。
      parcelize: true,
      parcelPitchM: 26,
      seamWideM: 5,
      // 四种切法：正交占近一半（城市该有的底子），跟随街区 / 斜切各一份，
      // 剩下一点给不规则地块。
      parcelPatterns: { ...DEFAULT_PARCEL_PATTERNS },
      seamNarrowM: 3.5,
      internalRoadW: 7,
      internalRoads: 'tensor',
      pathCellM: 8,
      pathTurn: 2.4,
      pathJitter: 0.3,
      // 街区尺度 1.5。
      //
      // 原来是 1.0（街区中位 74 m）。那个尺度下城市道路占掉 30% 的地，
      // 街区里再切地块就只剩"楼 + 一条草缝"了 —— 实测绿地 17%、沥青 38%。
      // 参考城市的比例是街区 120~180 m、道路 15%、绿地 35%：
      // 变大的是**街区**，不是路。街区一大，服务它的路就该退出城市路网、
      // 变成地块之间的巷道 —— 这正是 parcelize 那一层在做的事。
      spacingK: 1.5,
      // 禁建区的默认身份是"用户自建模型的场地"，不是"又一栋楼"
      zonePad: true,
      serviceLoop: true,
      loopW: 5.5,
      // 绿带 6 m 是三个约束的折中（8 seed 实测，禁建区地块）：
      //   3 m → 环路与城市路的人行道只隔一条硬质带，空中看还是一条宽路；
      //   9 m → 缓冲读得很清楚，但可建核心从 4865 掉到 4022 u²（−17%）；
      //   6 m → 命中率最高、可建核心 4256 u²，是拐点。
      loopVergeM: 6,
      loopMinM: 80,
      // 避障让距 12 m：路缘到禁区红线留一条绿化带。这个数不是随手取的 ——
      // 支路红线 10.5 m，路缘到中线 5.25 m；12 m 让"路缘 → 禁区"还剩 6.75 m，
      // 正好一排行道树 + 一条步道。再小（6 m）路缘几乎贴着禁区，读不出"避开"。
      zoneAvoid: true,
      zoneAvoidPadM: 12,
      zoneAvoidBend: false,
    },
    building: {
      towerChance: 0.3,
      towerChanceCore: 0.55,
      podiumHMin: 1.8,
      podiumHMax: 2.7,
      towerHMin: 6.5,
      towerHMaxCore: 15,
      towerHMaxEdge: 11.5,
      slabHMin: 2.2,
      slabHMax: 4.8,
      mergeChance: 0.22,
      tightRadius: 0.45,
      // 楼间距 14 m、每地块最多 3 栋 —— 参考图（住宅）里是"多栋平行板楼 + 内院"，
      // 2 栋是下限，3 栋以上要地块短边够大才排得下。
      spacingM: 12,
      podiumDepthM: 14,
      podiumChance: 0.15,
      maxPerParcel: 3,
    },
    green: {
      // 林地密度按"看得见树"给的：34 棵/1000 m² 在 150 m 见方的林地上会连成一整片绿，
      // 俯视图只剩色块。22 棵 + 24 m 的簇尺度，出来才是"一丛一丛 + 林窗"。
      //
      // 簇尺度定在 24 而不是 34：株距是簇尺度的 0.14 倍（跟着簇缩放），
      // 34 m 档的株距是 4.8 m，一个 17 m 半径的簇在 4.8 m 间距下顶多塞 11 棵 ——
      // 密度参数要 27 棵，实际只能落下 316/436（72%），林地会显得稀。
      // 24 m 档株距 3.4 m，同样一块地能落下 413/436，簇的分界也还看得清。
      treeDensity: 22,
      clusterScale: 24,
      edgeFeather: 10,
      shrubRatio: 0.25,
      pineRatio: 0.05,
    },
  };
}

/** 每个参数的合法区间。越界不是报错，是钳到边界 —— 面板误输入不该让整城崩掉。 */
const LIMITS: Record<string, [number, number]> = {
  'block.cellM': [10, 48],
  'block.gapM': [0.3, 6],
  'block.setbackK': [0, 0.12],
  'block.parcelTargetA': [20, 160],
  // 沿街面宽 18~48 m。下限 18：再窄一个地块就放不下"楼 + 退线 + 入户"；
  // 上限 48：再宽一栋楼就占满整条街面，地块交界读不出来。
  'block.parcelPitchM': [18, 48],
  'block.seamWideM': [2.5, 12],
  'block.seamNarrowM': [1.5, 8],
  'block.internalRoadW': [4, 14],
  'block.pathCellM': [4, 20],
  // 下限 0.5 不是随手取的：转弯惩罚为 0 时 A* 会走阶梯，
  // RDP 再把阶梯拉直成一条 45° 斜路 —— 斜穿街网的路在城里是错的。
  'block.pathTurn': [0.5, 8],
  'block.pathJitter': [0, 0.6],
  // 下限 0.7：再密就回到"路比楼多"。上限 2.5：再疏街区就大过 250 m，
  // 一条环路兜不住，得再套一层，那属于另一套模型了。
  'block.spacingK': [0.7, 2.5],
  // 楼间距下限 6 m：再窄两栋楼就贴成一片墙，剖面读不出"两栋"；
  // 上限 30 m：再宽一个院子就够再塞一栋了。
  'building.spacingM': [6, 30],
  'building.maxPerParcel': [1, 4],
  // 裙房进深 0~30 m：0 关掉，14 是"能放两排店面 + 一条内廊"的常见值
  'building.podiumDepthM': [0, 30],
  'building.podiumChance': [0, 1],
  'block.loopW': [3.5, 9],
  // 下限 3：绿带窄于 3 m 时，环路和城市路的人行道只隔一条硬质带，
  // 空中看就是一条 15 m 宽的宽路 —— 那正是环路要解决的问题，所以不给 0。
  'block.loopVergeM': [3, 12],
  'block.loopMinM': [50, 220],
  'block.zoneAvoidPadM': [4, 40],
  'building.towerChance': [0, 1],
  'building.towerChanceCore': [0, 1],
  'building.podiumHMin': [0.5, 6],
  'building.podiumHMax': [0.8, 8],
  'building.towerHMin': [1, 40],
  'building.towerHMaxCore': [2, 40],
  'building.towerHMaxEdge': [2, 40],
  'building.slabHMin': [0.4, 20],
  'building.slabHMax': [1, 24],
  'building.mergeChance': [0, 0.6],
  'building.tightRadius': [0.1, 0.9],
  'green.treeDensity': [2, 60],
  'green.clusterScale': [8, 140],
  'green.edgeFeather': [0, 20],
  'green.shrubRatio': [0, 1],
  'green.pineRatio': [0, 1],
};

function clampNum(key: string, v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const lim = LIMITS[key];
  if (!lim) return v;
  return Math.min(lim[1], Math.max(lim[0], v));
}

/**
 * 深合并 + 钳制。`min > max` 这类自相矛盾的区间按"交换"处理，
 * 而不是把两者都压到边界（那样会得到一片零高度的楼，画面直接空白）。
 */
export function resolveParams(p?: DeepPartial<TownParams>): TownParams {
  const d = defaultParams();
  const out: TownParams = {
    block: { ...d.block, ...(p?.block as BlockParams | undefined) },
    building: { ...d.building, ...(p?.building as BuildingParams | undefined) },
    green: { ...d.green, ...(p?.green as GreenParams | undefined) },
  };
  for (const sec of ['block', 'building', 'green'] as const) {
    const bag = out[sec] as unknown as Record<string, unknown>;
    const def = d[sec] as unknown as Record<string, unknown>;
    for (const k of Object.keys(bag)) {
      const key = `${sec}.${k}`;
      const v = bag[k];
      if (typeof v === 'number') bag[k] = clampNum(key, v, def[k] as number);
    }
  }
  const b = out.building;
  const swap = (a: keyof BuildingParams, c: keyof BuildingParams) => {
    const va = b[a] as number;
    const vc = b[c] as number;
    if (va > vc) {
      (b[a] as number) = vc;
      (b[c] as number) = va;
    }
  };
  swap('podiumHMin', 'podiumHMax');
  swap('towerHMin', 'towerHMaxCore');
  swap('towerHMin', 'towerHMaxEdge');
  swap('slabHMin', 'slabHMax');
  if (out.block.internalRoads !== 'path') out.block.internalRoads = 'tensor';
  // 模式权重是对象，深合并一层：面板只改其中一项时，其余三项不能丢
  const pat = out.block.parcelPatterns as Partial<BlockParams['parcelPatterns']> | undefined;
  out.block.parcelPatterns = {
    ...d.block.parcelPatterns,
    ...(pat ?? {}),
  };
  for (const k of ['ortho', 'diag', 'free', 'field'] as const) {
    const v = out.block.parcelPatterns[k];
    out.block.parcelPatterns[k] =
      typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d.block.parcelPatterns[k];
  }
  out.block.parcelize = out.block.parcelize !== false;
  out.block.zonePad = out.block.zonePad !== false;
  out.block.serviceLoop = out.block.serviceLoop !== false;
  out.block.zoneAvoid = out.block.zoneAvoid !== false;
  out.block.zoneAvoidBend = out.block.zoneAvoidBend === true;
  return out;
}

/** 给 UI 用的元信息：标签 / 单位 / 步长 */
/**
 * 参数所属的主题。
 *
 * 面板原来是"所有参数一个长列表"，用户要调街道宽度得先滚过一串建筑参数，
 * 反过来也一样 —— 参数和它真正影响的那块功能离得太远。
 * 所以每个参数都带一个主题，前端按主题把它挂到对应分区下面：
 *   街道 → 巷道宽 / 内部路 / 寻路代价
 *   禁建区 → 环路 / 避障让距
 *   地块 → 单元边长 / 地块面积 / 切分密度
 *   建筑 → 楼间缝 / 退线 / 塔楼比例 / 限高
 */
export type ParamTopic = 'parcel' | 'road' | 'loop' | 'avoid' | 'building';

export interface ParamSpec {
  key: string;
  label: string;
  unit?: string;
  step: number;
  min: number;
  max: number;
  topic: ParamTopic;
  /**
   * 这个参数**什么时候才生效**。
   *
   * 面板上几个看起来都相关的旋钮，生效范围其实完全不同。不写清楚，
   * 用户调完发现城市没反应 —— 或者反应和预期差很远。
   */
  hint?: string;
  /**
   * 收进「高级参数」折叠区（默认收起）。
   *
   * 用户核对意见："移除或者预设化一些复杂的参数，还有一些无效参数"。
   * 判定标准两条：① 默认值已经很难调坏；② 调整它只改变"精细度"，
   * 不改变城市读起来合不合理。这类参数留在主面板上只会让人不敢动。
   */
  adv?: boolean;
}

/**
 * 从面板上**移除**的参数（保留内核字段，值固定，不再暴露）：
 *
 *   · `cellM` 开发单元边长 —— 只在关掉「街区切成小地块」的老管线里读，
 *     而那条路现在只剩禁建区兜底走。主面板上它永远无效。
 *   · `parcelTargetA` 地块目标面积 —— 被「沿街面宽」取代；只有选中单块地块
 *     手动指定块数时才会被写，那不是面板上的全局参数。
 *   · `pathCellM / pathTurn / pathJitter` —— A* 内部路网的栅格与代价，只有
 *     "内部路网 = A* 寻路"时才读；路网形态本身默认是张量主轴直切，所以这三根
 *     只在「高级参数 → 巷道 / 内部路 / 寻路」里露出来。
 *
 * 从面板上**预设化**的参数：巷道宽 / 内部路宽 / 环路三件套 / 避让让距 /
 * 塔楼比例 / 退线系数 / 楼间缝 / 裙房进深与占比 / 内部路网形态 —— 全部收进
 * 「高级参数」折叠区（`ParamSpec.adv`）。
 */
export const BLOCK_SPECS: ParamSpec[] = [
  {
    key: 'parcelPitchM',
    label: '沿街面宽',
    unit: 'm',
    step: 1,
    ...lim('block.parcelPitchM'),
    topic: 'parcel',
    hint: '决定<b>沿街切几块</b>：面宽 26 m 时，74 m 见方的街区每边 3 块、一共 6 块地',
  },
  {
    key: 'spacingK',
    label: '街区尺度系数',
    step: 0.05,
    ...lim('block.spacingK'),
    topic: 'parcel',
    hint: '决定<b>街区有多大</b>（进而决定街区里装几个小地块）',
  },
  { key: 'seamWideM', label: '一级巷道宽', unit: 'm', step: 0.5, ...lim('block.seamWideM'), topic: 'road', adv: true },
  { key: 'seamNarrowM', label: '二级巷道宽', unit: 'm', step: 0.5, ...lim('block.seamNarrowM'), topic: 'road', adv: true },
  { key: 'internalRoadW', label: '内部路车行道', unit: 'm', step: 0.5, ...lim('block.internalRoadW'), topic: 'road', adv: true },
  { key: 'loopMinM', label: '环路触发跨度', unit: 'm', step: 5, ...lim('block.loopMinM'), topic: 'loop', adv: true },
  { key: 'loopW', label: '环路车行道', unit: 'm', step: 0.5, ...lim('block.loopW'), topic: 'loop', adv: true },
  { key: 'loopVergeM', label: '环路外侧绿带', unit: 'm', step: 0.5, ...lim('block.loopVergeM'), topic: 'loop', adv: true },
  { key: 'zoneAvoidPadM', label: '禁区避障让距', unit: 'm', step: 1, ...lim('block.zoneAvoidPadM'), topic: 'avoid', adv: true },
  { key: 'gapM', label: '楼间缝宽', unit: 'm', step: 0.1, ...lim('block.gapM'), topic: 'building', adv: true },
  { key: 'setbackK', label: '建筑退线系数', step: 0.002, ...lim('block.setbackK'), topic: 'building', adv: true },
];

export const BUILDING_SPECS: ParamSpec[] = [
  { key: 'spacingM', label: '楼栋间距', unit: 'm', step: 1, ...lim('building.spacingM'), topic: 'building' },
  { key: 'maxPerParcel', label: '每地块楼栋上限', unit: '栋', step: 1, ...lim('building.maxPerParcel'), topic: 'building' },
  {
    key: 'podiumDepthM',
    label: '连续裙房进深',
    unit: 'm',
    step: 1,
    ...lim('building.podiumDepthM'),
    topic: 'building',
    adv: true,
    hint: '商业 / 商务 / 市政地块的裙房围边厚度；设 0 = 不生成裙房',
  },
  {
    key: 'podiumChance',
    label: '裙房样式占比',
    step: 0.01,
    ...lim('building.podiumChance'),
    topic: 'building',
    adv: true,
    hint: '随机用"塔楼 + 裙房 + 内院"的比例（默认 0.15 = 15%）',
  },
  { key: 'towerChance', label: '塔楼比例（外围）', step: 0.02, ...lim('building.towerChance'), topic: 'building', adv: true },
  { key: 'towerChanceCore', label: '塔楼比例（中心）', step: 0.02, ...lim('building.towerChanceCore'), topic: 'building', adv: true },
  { key: 'mergeChance', label: '合并成板楼', step: 0.02, ...lim('building.mergeChance'), topic: 'building', adv: true },
  { key: 'slabHMax', label: '板楼最高', unit: '单位', step: 0.2, ...lim('building.slabHMax'), topic: 'building', adv: true },
  { key: 'towerHMaxCore', label: '塔楼最高（中心）', unit: '单位', step: 0.5, ...lim('building.towerHMaxCore'), topic: 'building', adv: true },
];

/**
 * 建筑高度档位预设。
 *
 * 面板上原来有 9 个建筑滑杆（塔楼比例 ×2、板楼最高、塔楼最高、合并比例、
 * 楼间缝、退线系数、裙房进深、裙房占比）—— 每个都"有用"，但没人能同时
 * 调好九个互斥的数。用户真正想说的是"这是低层城市还是高楼城市"。
 *
 * 所以收成一个四档选择，每档给一整组参数。选「混合」时**不动任何值**，
 * 保持各参数当前状态 —— 这样从「低层」切回「混合」不会丢掉手调过的数。
 */
export interface BuildingPreset {
  key: string;
  label: string;
  desc: string;
  apply?: Partial<BuildingParams>;
}

export const BUILDING_PRESETS: BuildingPreset[] = [
  {
    key: 'mixed',
    label: '混合',
    desc: '保持当前各项参数（中心高、外围低）',
  },
  {
    key: 'low',
    label: '低层',
    desc: '1~3 层为主，几乎没有塔楼（古镇 / 郊区住区）',
    apply: {
      slabHMin: 0.7,
      slabHMax: 1.6,
      towerHMin: 1.4,
      towerHMaxCore: 2.6,
      towerHMaxEdge: 2.0,
      podiumHMin: 0.7,
      podiumHMax: 1.2,
      towerChance: 0.02,
      towerChanceCore: 0.04,
      mergeChance: 0.34,
      podiumChance: 0.05,
    },
  },
  {
    key: 'mid',
    label: '多层',
    desc: '4~6 层板楼为主，少量塔楼（欧洲街区 / 老城）',
    apply: {
      slabHMin: 1.7,
      slabHMax: 3.0,
      towerHMin: 3.2,
      towerHMaxCore: 5.2,
      towerHMaxEdge: 4.2,
      podiumHMin: 1.1,
      podiumHMax: 1.8,
      towerChance: 0.08,
      towerChanceCore: 0.14,
      mergeChance: 0.3,
      podiumChance: 0.12,
    },
  },
  {
    key: 'high',
    label: '中高层',
    desc: '7~15 层为主，中心有塔楼（国内常见新区）',
    apply: {
      slabHMin: 3.0,
      slabHMax: 5.4,
      towerHMin: 6.0,
      towerHMaxCore: 11.5,
      towerHMaxEdge: 9.0,
      podiumHMin: 1.6,
      podiumHMax: 2.5,
      towerChance: 0.26,
      towerChanceCore: 0.5,
      mergeChance: 0.24,
      podiumChance: 0.16,
    },
  },
  {
    key: 'tall',
    label: '高层',
    desc: '16 层以上，中心成簇（CBD）',
    apply: {
      slabHMin: 4.6,
      slabHMax: 8.0,
      towerHMin: 8.5,
      towerHMaxCore: 16.5,
      towerHMaxEdge: 13,
      podiumHMin: 1.8,
      podiumHMax: 2.8,
      towerChance: 0.46,
      towerChanceCore: 0.72,
      mergeChance: 0.18,
      podiumChance: 0.2,
    },
  },
];


/** 一个参数属于哪个参数对象（block / building），UI 提交时要用它定位 */
export interface TopicSpec {
  ns: 'block' | 'building';
  sp: ParamSpec;
}

/** 全部参数，按主题索引。前端每个分区只渲染自己那几行 */
export const SPECS_BY_TOPIC: Record<ParamTopic, TopicSpec[]> = {
  parcel: BLOCK_SPECS.filter((s) => s.topic === 'parcel').map((sp) => ({ ns: 'block' as const, sp })),
  road: BLOCK_SPECS.filter((s) => s.topic === 'road').map((sp) => ({ ns: 'block' as const, sp })),
  loop: BLOCK_SPECS.filter((s) => s.topic === 'loop').map((sp) => ({ ns: 'block' as const, sp })),
  avoid: BLOCK_SPECS.filter((s) => s.topic === 'avoid').map((sp) => ({ ns: 'block' as const, sp })),
  building: [
    ...BLOCK_SPECS.filter((s) => s.topic === 'building').map((sp) => ({ ns: 'block' as const, sp })),
    ...BUILDING_SPECS.map((sp) => ({ ns: 'building' as const, sp })),
  ],
};

function lim(key: string): { min: number; max: number } {
  const l = LIMITS[key];
  return { min: l[0], max: l[1] };
}
