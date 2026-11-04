/**
 * 停车方式决策。
 *
 * ## 为什么要它
 *
 * 现在的做法是"每个地块都生成一块地面停车"——于是整座城看过去到处是停车场，
 * 层数低的住宅区也一样。真实城市不是这样：
 *
 * | 场景 | 停车方式 |
 * |---|---|
 * | 多层住宅区（建得满、地少） | **地下车库**，地面全是绿地和院子 |
 * | 小地块 / 小建筑 / 独栋 | **路侧停车**，沿街几个位，不占地块内部 |
 * | 工业园 / 郊区商业 / 大地块 | **地面停车场**（现状） |
 * | 数据中心 / 变电站 | **基本没有停车**，只在门口留几个 |
 *
 * 判断依据是**建筑覆盖率**和**地块面积**这两件事：
 * 房子盖得越满，地面就越该让给人和绿化；地块越大，才越放得下一个车场。
 *
 * ## 阈值来自哪里
 *
 * - 覆盖率 30~35%：多层住宅/商业做到这个量级时，地面已经没有完整的
 *   停车场尺寸（一个 40 车位的地面场要 1000 m² 以上）；
 * - 地块 3000 m²：小于这个数，地面停车区和建筑会互相啃，
 *   实际项目里这种地块就是沿街停车。
 */
export type ParkingMode =
  /** 地面停车场（现状） */
  | 'surface'
  /** 路侧停车：沿街一条窄带，不占地块内部 */
  | 'street'
  /** 地下车库：地面不出现停车区 */
  | 'underground'
  /** 基本无停车 */
  | 'none';

export interface ParkingModeInput {
  /** 地块面积（m²） */
  lotM2: number;
  /** 建筑基底总面积（m²） */
  bldM2: number;
  typology: string;
}

const U = 7;

export function chooseParkingMode(inp: ParkingModeInput): ParkingMode {
  const { lotM2, bldM2, typology } = inp;
  const coverage = lotM2 > 1e-6 ? bldM2 / lotM2 : 0;

  // 工业：永远是地面停车场（货车、员工车、装卸），不进地下
  if (typology === 'industrial') return 'surface';
  // 数据中心：只有门口几个位
  if (typology === 'data_center') return 'none';
  // 独栋：路边停
  if (typology === 'single_family') return 'street';

  // 酒店：市中心酒店基本都有地库（塔楼占满地块）
  if (typology === 'hotel') return coverage > 0.25 || lotM2 < 6000 ? 'underground' : 'surface';

  // 住宅 / 零售：三层判断
  //   ① 建得满（>30%）→ 地库 —— 地面要留院子和绿地
  //   ② 地块小（<3000 m²）→ 路侧
  //   ③ 否则地面停车场
  if (coverage > 0.3) return 'underground';
  if (lotM2 < 3000) return 'street';
  // 大地块但建筑很少（<12%）→ 也放地面场，不然一片空地
  return 'surface';
}

/** 路侧停车带的宽度（m）：一条车道 + 车位，实际 5.5 m 够停一排 */
export const STREET_PARK_DEPTH_M = 5.5;
void U;
