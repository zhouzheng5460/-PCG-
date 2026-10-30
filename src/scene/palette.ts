// 现代城市材质调色板。
// 全流程只有一套颜色：2D 画布、three.js 预览、GLB 导出都从这里取，
// 保证"编辑时看到的路面色"就是"导出的路面色"。
// 数值是 sRGB 0~1（glTF baseColorFactor 与 canvas fillStyle 通用）。

export type MatKey =
  // 地面 / 硬质铺装
  | 'ground'
  | 'asphalt'
  | 'asphaltLot'
  | 'concrete'
  | 'paver'
  | 'brickPave'
  | 'stonePave'
  | 'gravel'
  | 'curb'
  // 软质
  | 'grass'
  | 'grassDark'
  | 'soil'
  | 'water'
  // 标线
  | 'markWhite'
  | 'markYellow'
  // 屋面
  | 'roofFlat'
  | 'roofLight'
  | 'roofDark'
  | 'roofMetal'
  // 墙面
  | 'wallConcrete'
  | 'wallBrick'
  | 'wallGlass'
  | 'wallPanel'
  | 'wallStone'
  // 设施
  | 'metal'
  | 'wood'
  | 'trunk'
  | 'leaf'
  | 'leafDark'
  | 'fence';

export const MAT: Record<MatKey, [number, number, number]> = {
  ground: [0.408, 0.396, 0.372],
  asphalt: [0.243, 0.253, 0.275],
  // 停车场沥青比车行道略深一点点就够，再深就从"停车"读成"空洞"了
  asphaltLot: [0.268, 0.278, 0.302],
  concrete: [0.663, 0.655, 0.628],
  paver: [0.706, 0.667, 0.604],
  brickPave: [0.588, 0.404, 0.333],
  stonePave: [0.757, 0.733, 0.690],
  gravel: [0.549, 0.529, 0.482],
  curb: [0.800, 0.788, 0.757],

  grass: [0.361, 0.502, 0.271],
  grassDark: [0.278, 0.404, 0.212],
  soil: [0.412, 0.353, 0.267],
  water: [0.286, 0.443, 0.522],

  markWhite: [0.925, 0.925, 0.902],
  markYellow: [0.851, 0.706, 0.239],

  roofFlat: [0.400, 0.412, 0.431],
  // 浅色屋面必须和石材铺装拉开差距：原来的 0.78/0.769/0.741 和 stonePave
  // (0.757/0.733/0.690) 几乎是同一个颜色，2D 上一片浅色地块分不清"这是楼"
  // 还是"这是空地"，整块封闭地读起来像一格一格的空场。压到中性灰并略微偏冷。
  roofLight: [0.615, 0.622, 0.638],
  roofDark: [0.298, 0.310, 0.329],
  roofMetal: [0.522, 0.549, 0.580],

  wallConcrete: [0.800, 0.780, 0.749],
  wallBrick: [0.702, 0.549, 0.467],
  wallGlass: [0.471, 0.600, 0.659],
  wallPanel: [0.620, 0.635, 0.635],
  wallStone: [0.859, 0.831, 0.769],

  metal: [0.561, 0.580, 0.612],
  wood: [0.541, 0.380, 0.251],
  trunk: [0.322, 0.251, 0.192],
  leaf: [0.298, 0.451, 0.239],
  leafDark: [0.220, 0.353, 0.180],
  fence: [0.471, 0.494, 0.529],
};

/** 画布用 CSS 颜色 */
export function css(k: MatKey, alpha = 1): string {
  const c = MAT[k];
  const r = Math.round(c[0] * 255);
  const g = Math.round(c[1] * 255);
  const b = Math.round(c[2] * 255);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 树的一撮绿。
 *
 * 树在 2D 画布、三维预览、GLB 里都是**立方体**（不是锥体），
 * 颜色从下面这几档里按 seed 取一个，再叠一点点亮度抖动。
 * 三处共用同一张表、同一个取值函数，所以"画布上的树"和"导出的树"颜色一致。
 *
 * 为什么用立方体：一座城的树是几百到上千棵，锥体每棵 18 面、立方体只要 12 面，
 * 而且方头方脑的树在俯视图里更容易和灌木 / 路灯分开 —— 细看锥体顶在 2D 上
 * 只是一个圆点，压根看不出是树。
 */
export const TREE_GREENS: [number, number, number][] = [
  [0.235, 0.412, 0.196],
  [0.298, 0.451, 0.239],
  [0.353, 0.494, 0.251],
  [0.196, 0.353, 0.169],
  [0.271, 0.478, 0.290],
  [0.404, 0.522, 0.259],
];

/** seed → 一档绿（确定性：同一个 seed 永远同一个颜色，重建不会跳） */
export function treeGreen(seed: number): [number, number, number] {
  const i = Math.abs(Math.floor(seed * 7.31)) % TREE_GREENS.length;
  return TREE_GREENS[i];
}

/** 同上，但要 CSS 字符串（2D 画布用） */
export function treeGreenCss(seed: number, lift = 0): string {
  const c = treeGreen(seed);
  const f = (v: number) => Math.round(Math.min(1, v + lift) * 255);
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

/** 按用途给出地坪基调，2D 里用来区分地块性质 */
export const USE_COLOR: Record<string, [number, number, number]> = {
  cbd: [0.62, 0.63, 0.66],
  commercial: [0.68, 0.63, 0.58],
  residential: [0.63, 0.66, 0.56],
  industrial: [0.60, 0.59, 0.55],
  civic: [0.72, 0.70, 0.65],
  park: [0.40, 0.54, 0.30],
  parking: [0.30, 0.31, 0.33],
  green: [0.36, 0.50, 0.27],
  // 禁建 / 保留：比绿地灰、比铺装暖，读起来是"这块地留着没用起来"
  reserved: [0.58, 0.56, 0.50],
};
