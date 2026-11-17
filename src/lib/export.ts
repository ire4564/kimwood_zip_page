// 배치 결과를 원본 해상도 PNG로 내보내기 (캔버스에서 투시 변환을 직접 계산)
import { apply, mul, type Mat3, type Pt } from './homography';
import type { Correction } from './correction';
import { renderCorrected } from './warp';
import { frameLocal, type Frame } from '../types';
import { loadImage } from './storage';

function poly(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

const rectPts = (H: Mat3, x: number, y: number, w: number, h: number) =>
  [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ].map((p) => apply(H, p));

function drawTri(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  s: [Pt, Pt, Pt],
  d: [Pt, Pt, Pt],
) {
  const [s0, s1, s2] = s;
  const [d0, d1, d2] = d;
  const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(det) < 1e-9) return;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / det;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / det;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / det;
  const dd = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / det;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - dd * s0.y;
  // 이음새가 보이지 않도록 삼각형을 살짝 확장해서 클립
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const grow = (p: Pt) => {
    const l = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / l) * 0.6, y: p.y + ((p.y - cy) / l) * 0.6 };
  };
  ctx.save();
  poly(ctx, [grow(d0), grow(d1), grow(d2)]);
  ctx.clip();
  ctx.transform(a, b, c, dd, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

export function drawWarped(
  ctx: CanvasRenderingContext2D,
  art: HTMLImageElement,
  H: Mat3,
  x: number,
  y: number,
  w: number,
  h: number,
  cover = true,
  N = 16,
) {
  // object-fit: cover 와 동일한 크롭
  const aw = art.naturalWidth, ah = art.naturalHeight;
  const ra = w / h;
  let sx = 0, sy = 0, sw = aw, sh = ah;
  if (cover) {
    if (aw / ah > ra) { sw = ah * ra; sx = (aw - sw) / 2; } else { sh = aw / ra; sy = (ah - sh) / 2; }
  }
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N;
      const S = (u: number, v: number) => ({ x: sx + u * sw, y: sy + v * sh });
      const D = (u: number, v: number) => apply(H, { x: x + u * w, y: y + v * h });
      drawTri(ctx, art, [S(u0, v0), S(u1, v0), S(u1, v1)], [D(u0, v0), D(u1, v0), D(u1, v1)]);
      drawTri(ctx, art, [S(u0, v0), S(u1, v1), S(u0, v1)], [D(u0, v0), D(u1, v1), D(u0, v1)]);
    }
}

export async function exportPNG(
  photo: HTMLImageElement,
  frames: Frame[],
  HwiRaw: Mat3,
  opacity: number,
  corr: Correction,
): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = corr.outW;
  c.height = corr.outH;
  const ctx = c.getContext('2d')!;
  const W = photo.naturalWidth, H = photo.naturalHeight;
  paintPhoto(photo, corr, c);
  void W; void H;
  const Hwi = mul(corr.C, HwiRaw); // 벽 cm → 보정된 화면 px
  for (const f of frames) {
    ctx.globalAlpha = opacity;
    const M = mul(Hwi, frameLocal(f)); // 액자 안쪽 cm → 화면 px (회전 포함)
    const outer = rectPts(M, 0, 0, f.w, f.h);
    ctx.save();
    const scale = Math.hypot(outer[1].x - outer[0].x, outer[1].y - outer[0].y) / f.w; // px/cm
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 1.2 * scale;
    ctx.shadowOffsetY = 0.4 * scale;
    poly(ctx, outer);
    ctx.fillStyle = f.color;
    ctx.fill();
    ctx.restore();
    const b = f.border;
    if (f.mat > 0) {
      poly(ctx, rectPts(M, b, b, f.w - 2 * b, f.h - 2 * b));
      ctx.fillStyle = f.matColor;
      ctx.fill();
    }
    const ix = b + f.mat, iy = b + f.mat;
    const iw = f.w - 2 * (b + f.mat), ih = f.h - 2 * (b + f.mat);
    if (iw > 0 && ih > 0) {
      if (f.art) {
        const art = await loadImage(f.art);
        drawWarped(ctx, art, M, ix, iy, iw, ih);
      } else {
        poly(ctx, rectPts(M, ix, iy, iw, ih));
        ctx.fillStyle = '#ebe7e1';
        ctx.fill();
      }
    }
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('export failed'))), 'image/png'));
}

const isIdentityC = (c: Correction) =>
  c.C[0] === 1 && c.C[4] === 1 && !c.C[1] && !c.C[2] && !c.C[3] && !c.C[5] && !c.C[6] && !c.C[7];

/** 캔버스(outW×outH)에 (보정된) 사진을 그린다. WebGL 정확 보정 → 실패 시 삼각형 분할 근사 */
export function paintPhoto(photo: HTMLImageElement, corr: Correction, target: HTMLCanvasElement) {
  if (target.width !== corr.outW) target.width = corr.outW;
  if (target.height !== corr.outH) target.height = corr.outH;
  const ctx = target.getContext('2d')!;
  if (isIdentityC(corr)) {
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(photo, 0, 0);
    return;
  }
  if (renderCorrected(photo, corr, target)) return;
  ctx.clearRect(0, 0, target.width, target.height);
  drawWarped(ctx, photo, corr.C, 0, 0, photo.naturalWidth, photo.naturalHeight, false, 32);
}
