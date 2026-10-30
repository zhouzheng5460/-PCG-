// 仅用于验证的软件光栅化器：等轴测正交投影 + z-buffer + 平光着色。
// 目的是在不开浏览器的情况下确认 3D 几何、绕序和遮挡关系是否正确。

import type { Primitive } from '../src/export/build3d';

export interface RenderOptions {
  size?: number;
  azimuth?: number; // 度
  elevation?: number; // 度
  background?: [number, number, number];
  zoom?: number;
}

export function renderPrimitives(prims: Primitive[], opts: RenderOptions = {}): { width: number; height: number; rgba: Uint8Array; ids: Int32Array } {
  const W = opts.size ?? 900;
  const H = W;
  const az = ((opts.azimuth ?? 45) * Math.PI) / 180;
  const el = ((opts.elevation ?? 35.264) * Math.PI) / 180;
  const bg = opts.background ?? [0.16, 0.17, 0.19];

  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bg[0] * 255;
    rgba[i * 4 + 1] = bg[1] * 255;
    rgba[i * 4 + 2] = bg[2] * 255;
    rgba[i * 4 + 3] = 255;
  }
  const depth = new Float32Array(W * H).fill(Infinity);
  const ids = new Int32Array(W * H).fill(-1);

  // 取景按"有立面的几何"算，避免被整块地面底板撑小
  const framed = prims.filter((p) => p.group !== 'ground');
  const source = framed.length > 0 ? framed : prims;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of source)
    for (let i = 0; i < p.positions.length; i += 3) {
      minX = Math.min(minX, p.positions[i]); maxX = Math.max(maxX, p.positions[i]);
      minY = Math.min(minY, p.positions[i + 1]); maxY = Math.max(maxY, p.positions[i + 1]);
      minZ = Math.min(minZ, p.positions[i + 2]); maxZ = Math.max(maxZ, p.positions[i + 2]);
    }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxZ - minZ, maxY - minY) || 1;
  const scale = ((W * 0.86) / span) * (opts.zoom ?? 1);

  const cosA = Math.cos(az), sinA = Math.sin(az);
  const cosE = Math.cos(el), sinE = Math.sin(el);
  const light = normalize([0.35, 0.86, 0.36]);

  const project = (x: number, y: number, z: number) => {
    const tx = x - cx, ty = y - cy, tz = z - cz;
    const rx = tx * cosA - tz * sinA;
    const rz = tx * sinA + tz * cosA;
    const sy = ty * cosE - rz * sinE;
    // 相机在上方俯视：高度越大离相机越近，所以深度取负
    const depthV = -(ty * sinE + rz * cosE);
    return { sx: W / 2 + rx * scale, sy: H / 2 - sy * scale, sz: depthV };
  };

  for (let pi = 0; pi < prims.length; pi++) {
    const prim = prims[pi];
    const { positions, normals, indices, color } = prim;
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3;
      const A = project(positions[ia], positions[ia + 1], positions[ia + 2]);
      const B = project(positions[ib], positions[ib + 1], positions[ib + 2]);
      const C = project(positions[ic], positions[ic + 1], positions[ic + 2]);

      const area = (B.sx - A.sx) * (C.sy - A.sy) - (C.sx - A.sx) * (B.sy - A.sy);
      if (Math.abs(area) < 1e-9) continue;

      // 面法线（用世界坐标）+ 平光
      const ux = positions[ib] - positions[ia], uy = positions[ib + 1] - positions[ia + 1], uz = positions[ib + 2] - positions[ia + 2];
      const vx = positions[ic] - positions[ia], vy = positions[ic + 1] - positions[ia + 1], vz = positions[ic + 2] - positions[ia + 2];
      const n = normalize([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
      const shade = 0.45 + 0.55 * Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      const r = Math.min(255, color[0] * shade * 255);
      const g = Math.min(255, color[1] * shade * 255);
      const b = Math.min(255, color[2] * shade * 255);

      const minPX = Math.max(0, Math.floor(Math.min(A.sx, B.sx, C.sx)));
      const maxPX = Math.min(W - 1, Math.ceil(Math.max(A.sx, B.sx, C.sx)));
      const minPY = Math.max(0, Math.floor(Math.min(A.sy, B.sy, C.sy)));
      const maxPY = Math.min(H - 1, Math.ceil(Math.max(A.sy, B.sy, C.sy)));

      for (let py = minPY; py <= maxPY; py++) {
        for (let px = minPX; px <= maxPX; px++) {
          const w0 = ((B.sx - A.sx) * (py + 0.5 - A.sy) - (px + 0.5 - A.sx) * (B.sy - A.sy)) / area;
          const w1 = ((px + 0.5 - A.sx) * (C.sy - A.sy) - (C.sx - A.sx) * (py + 0.5 - A.sy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;

          // 注意：这里的 w0 是顶点 C 的权重、w1 是 B、w2 是 A。
          // 之前按 A,B,C 直取，深度插值错位，同高度附近的两层铺装会被随机判出前后，
          // 渲染出来就是"星形碎裂"的假象（场景本身没有自交）。
          const z = A.sz * w2 + B.sz * w1 + C.sz * w0;
          const idx = py * W + px;
          if (z >= depth[idx]) continue;
          depth[idx] = z;
          rgba[idx * 4] = r;
          rgba[idx * 4 + 1] = g;
          rgba[idx * 4 + 2] = b;
          rgba[idx * 4 + 3] = 255;
          ids[idx] = pi;
        }
      }
    }
  }

  return { width: W, height: H, rgba, ids };
}

function normalize(v: number[]): number[] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
