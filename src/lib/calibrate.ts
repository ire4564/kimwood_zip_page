// 여러 기준 액자를 동시에 사용하는 보정 (번들 조정 방식).
//
// 미지수: 벽(cm) → 사진(px) 호모그래피 H (8개) + 첫 번째를 제외한 각 기준 액자의 벽 위 위치·기울기 (x, y, θ)
// 관측값: 모든 기준 액자의 네 모서리 클릭 위치 (px)
// 목적함수: Σ |H·(액자 모서리의 벽 좌표) − 클릭한 위치|²  → Levenberg–Marquardt 로 최소화
//
// 액자들의 서로 간 거리를 몰라도 되고, 기준이 넓게 퍼질수록 원근(특히 먼 곳의 축척)이 정확해진다.
import { apply, invert, isConvexQuad, solveHomography, solveLinear, mul, type Mat3, type Pt } from './homography';

export interface RefFrame {
  id: string;
  name: string;
  corners: [Pt, Pt, Pt, Pt] | null; // TL, TR, BR, BL (원본 사진 px)
  widthCm: number;
  heightCm: number;
}

export interface RefPose {
  id: string;
  x: number; // 벽 좌표 cm (왼쪽 위 모서리)
  y: number;
  theta: number; // rad
}

export interface RefDiag {
  id: string;
  rmsPx: number; // 이 기준의 모서리 재투영 오차 (원본 px)
  maxPx: number;
  measuredW: number; // 최종 결과로 잰 크기
  measuredH: number;
  tiltDeg: number; // 첫 기준 대비 기울기
}

export interface Solution {
  Hiw: Mat3; // 사진 px → 벽 cm
  Hwi: Mat3; // 벽 cm → 사진 px
  poses: RefPose[];
  diags: RefDiag[];
  rmsPx: number;
  pxPerCm: number; // 첫 기준 중심의 해상도
}

export const refReady = (r: RefFrame) =>
  !!r.corners && r.widthCm > 0 && r.heightCm > 0 && isConvexQuad(r.corners);

const localRect = (w: number, h: number): Pt[] => [
  { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
];

const placed = (pts: Pt[], x: number, y: number, t: number) => {
  const c = Math.cos(t), s = Math.sin(t);
  return pts.map((p) => ({ x: x + c * p.x - s * p.y, y: y + s * p.x + c * p.y }));
};

/** 벽 위 기준 액자 네 모서리 (cm) */
export function poseCorners(r: RefFrame, pose: RefPose): Pt[] {
  return placed(localRect(r.widthCm, r.heightCm), pose.x, pose.y, pose.theta);
}

export function solveCalibration(refsAll: RefFrame[]): Solution | null {
  if (!refsAll.length || !refReady(refsAll[0])) return null;
  const refs = refsAll.filter(refReady);
  const r0 = refs[0];

  // ── 정규화 (수치 안정성): 사진 좌표는 Hartley 정규화, 벽 좌표는 m 단위
  const allImg = refs.flatMap((r) => r.corners!);
  const cx = allImg.reduce((s, p) => s + p.x, 0) / allImg.length;
  const cy = allImg.reduce((s, p) => s + p.y, 0) / allImg.length;
  const md = allImg.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / allImg.length || 1;
  const k = Math.SQRT2 / md;
  const Ti = [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
  const Tii = invert(Ti);
  const U = 100; // cm → m
  const obs = refs.map((r) => r.corners!.map((p) => apply(Ti, p)));
  const locals = refs.map((r) => localRect(r.widthCm / U, r.heightCm / U));

  // ── 초기값: 첫 기준만으로 구한 호모그래피 + 나머지 기준의 대략적 위치
  const Hiw0 = solveHomography(r0.corners!, localRect(r0.widthCm, r0.heightCm));
  const Hwi0 = invert(Hiw0);
  // 정규화 공간: wall(m) → img(norm) = Ti · Hwi0 · diag(U,U,1)
  let Hn = mul(Ti, mul(Hwi0, [U, 0, 0, 0, U, 0, 0, 0, 1]));
  Hn = Hn.map((v) => v / Hn[8]);
  const params: number[] = Hn.slice(0, 8);
  for (let i = 1; i < refs.length; i++) {
    const w = refs[i].corners!.map((p) => apply(Hiw0, p)).map((p) => ({ x: p.x / U, y: p.y / U }));
    const l = locals[i];
    const cw = { x: w.reduce((s, p) => s + p.x, 0) / 4, y: w.reduce((s, p) => s + p.y, 0) / 4 };
    const cl = { x: l.reduce((s, p) => s + p.x, 0) / 4, y: l.reduce((s, p) => s + p.y, 0) / 4 };
    let num = 0, den = 0;
    for (let j = 0; j < 4; j++) {
      const lx = l[j].x - cl.x, ly = l[j].y - cl.y, wx = w[j].x - cw.x, wy = w[j].y - cw.y;
      num += lx * wy - ly * wx;
      den += lx * wx + ly * wy;
    }
    const t = Math.atan2(num, den);
    const c = Math.cos(t), s = Math.sin(t);
    params.push(cw.x - (c * cl.x - s * cl.y), cw.y - (s * cl.x + c * cl.y), t);
  }

  const residuals = (p: number[]): number[] => {
    const H = [...p.slice(0, 8), 1];
    const out: number[] = [];
    for (let i = 0; i < refs.length; i++) {
      const wc = i === 0 ? locals[0] : placed(locals[i], p[8 + (i - 1) * 3], p[9 + (i - 1) * 3], p[10 + (i - 1) * 3]);
      for (let j = 0; j < 4; j++) {
        const q = apply(H, wc[j]);
        out.push(q.x - obs[i][j].x, q.y - obs[i][j].y);
      }
    }
    return out;
  };

  // ── Levenberg–Marquardt
  let p = params;
  let r = residuals(p);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  const n = p.length;
  for (let it = 0; it < 100 && refs.length > 1; it++) {
    const J: number[][] = r.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = Math.max(Math.abs(p[j]) * 1e-7, 1e-10);
      const pp = [...p]; pp[j] += h;
      const pm = [...p]; pm[j] -= h;
      const rp = residuals(pp), rm = residuals(pm);
      for (let i = 0; i < r.length; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
    }
    const JtJ = Array.from({ length: n }, (_, a) =>
      Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const Jtr = Array.from({ length: n }, (_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      let d: number[];
      try { d = solveLinear(A, Jtr.map((v) => -v)); } catch { lambda *= 10; continue; }
      const pn = p.map((v, i) => v + d[i]);
      const rn = residuals(pn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        const rel = (cost - cn) / (cost || 1);
        p = pn; r = rn; cost = cn; lambda = Math.max(lambda / 10, 1e-12);
        improved = rel > 1e-12;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }

  // ── 결과를 cm/px 단위로 되돌리기
  const HnF = [...p.slice(0, 8), 1];
  let Hwi = mul(Tii, mul(HnF, [1 / U, 0, 0, 0, 1 / U, 0, 0, 0, 1]));
  Hwi = Hwi.map((v) => v / Hwi[8]);
  const Hiw = invert(Hwi);

  const poses: RefPose[] = refs.map((rf, i) =>
    i === 0
      ? { id: rf.id, x: 0, y: 0, theta: 0 }
      : { id: rf.id, x: p[8 + (i - 1) * 3] * U, y: p[9 + (i - 1) * 3] * U, theta: p[10 + (i - 1) * 3] });

  let sumSq = 0;
  const diags: RefDiag[] = refs.map((rf, i) => {
    const wc = poseCorners(rf, poses[i]);
    const errs = wc.map((w, j) => {
      const q = apply(Hwi, w);
      return Math.hypot(q.x - rf.corners![j].x, q.y - rf.corners![j].y);
    });
    sumSq += errs.reduce((s, e) => s + e * e, 0);
    const m = rf.corners!.map((c) => apply(Hiw, c));
    const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
    return {
      id: rf.id,
      rmsPx: Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / 4),
      maxPx: Math.max(...errs),
      measuredW: (d(m[0], m[1]) + d(m[3], m[2])) / 2,
      measuredH: (d(m[0], m[3]) + d(m[1], m[2])) / 2,
      tiltDeg: (poses[i].theta * 180) / Math.PI,
    };
  });

  const c0 = { x: r0.widthCm / 2, y: r0.heightCm / 2 };
  const pc = apply(Hwi, c0);
  const pxPerCm = Math.min(
    Math.hypot(...((q) => [q.x - pc.x, q.y - pc.y] as [number, number])(apply(Hwi, { x: c0.x + 1, y: c0.y }))),
    Math.hypot(...((q) => [q.x - pc.x, q.y - pc.y] as [number, number])(apply(Hwi, { x: c0.x, y: c0.y + 1 }))),
  );

  return { Hiw, Hwi, poses, diags, rmsPx: Math.sqrt(sumSq / (refs.length * 4)), pxPerCm };
}
