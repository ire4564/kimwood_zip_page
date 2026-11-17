import type { Pt } from './lib/homography';
import { noAdjust, type Adjust } from './lib/correction';
import type { RefFrame } from './lib/calibrate';

export type Quad = [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL (사진 원본 픽셀 좌표)

export interface Calibration {
  /** 기준 액자들. 첫 번째 기준의 왼쪽 위 모서리가 벽 좌표 원점 */
  refs: RefFrame[];
}

export const newRef = (n: number): RefFrame => ({
  id: Math.random().toString(36).slice(2, 10),
  name: `기준 ${n}`,
  corners: null,
  widthCm: 0,
  heightCm: 0,
});

/** 예전 저장 형식(기준 1개) → 새 형식으로 변환 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeCal(c: any): Calibration {
  if (c && Array.isArray(c.refs)) return { refs: c.refs.length ? c.refs : [newRef(1)] };
  const r = newRef(1);
  if (c) Object.assign(r, { corners: c.corners ?? null, widthCm: c.widthCm || 0, heightCm: c.heightCm || 0 });
  return { refs: [r] };
}

export interface Frame {
  id: string;
  name: string;
  /** 벽 좌표(cm): 기준 액자 왼쪽 위 모서리가 원점, 오른쪽 +x, 아래 +y */
  x: number;
  y: number;
  w: number;
  h: number;
  border: number; // 프레임 두께 cm
  color: string;
  mat: number; // 매트(여백) 두께 cm
  matColor: string;
  art: string | null; // dataURL
  rot?: number; // 회전(°), 시계 방향, 액자 중심 기준
}

/** 액자 안쪽 좌표(cm, 0..w × 0..h) → 벽 좌표(cm). 중심을 기준으로 회전 */
export function frameLocal(f: Pick<Frame, 'x' | 'y' | 'w' | 'h' | 'rot'>): number[] {
  const t = ((f.rot ?? 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  return [c, -s, cx - (c * f.w) / 2 + (s * f.h) / 2, s, c, cy - (s * f.w) / 2 - (c * f.h) / 2, 0, 0, 1];
}

/** 벽 위 액자 네 모서리 (TL, TR, BR, BL) */
export function frameCorners(f: Pick<Frame, 'x' | 'y' | 'w' | 'h' | 'rot'>): Pt[] {
  const M = frameLocal(f);
  return [{ x: 0, y: 0 }, { x: f.w, y: 0 }, { x: f.w, y: f.h }, { x: 0, y: f.h }].map((p) => ({
    x: M[0] * p.x + M[1] * p.y + M[2],
    y: M[3] * p.x + M[4] * p.y + M[5],
  }));
}

/** 회전을 포함한 바깥 경계 상자 (자석 정렬·간격 계산용) */
export function frameBox(f: Pick<Frame, 'x' | 'y' | 'w' | 'h' | 'rot'>) {
  if (!f.rot) return { x: f.x, y: f.y, w: f.w, h: f.h };
  const c = frameCorners(f);
  const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export interface Measurement {
  id: string;
  a: Pt; // 사진 원본 픽셀 좌표
  b: Pt;
}

export interface Project {
  imageBlob: Blob | null;
  imageW: number;
  imageH: number;
  adjust: Adjust;
  calibration: Calibration;
  frames: Frame[];
  measurements: Measurement[];
}

export type Mode = 'straighten' | 'calibrate' | 'arrange' | 'measure';

export const emptyProject = (): Project => ({
  imageBlob: null,
  imageW: 0,
  imageH: 0,
  adjust: noAdjust(),
  calibration: { refs: [newRef(1)] },
  frames: [],
  measurements: [],
});

export const uid = () => Math.random().toString(36).slice(2, 10);
