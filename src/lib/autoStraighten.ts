// 자동 수직·수평 보정
// 1) 사진에서 거의 세로/가로인 직선을 찾는다 (Sobel 경계 + 허프 변환 + 실제 선분 추출)
// 2) 보정(회전·수직 원근·수평 원근) 값을 바꿔가며, 보정 후 그 선들이 정확히 세로/가로가 되는 값을 찾는다
import { apply } from './homography';
import { computeCorrection, type Adjust } from './correction';

export interface LineSeg {
  x1: number; y1: number; x2: number; y2: number; // 원본 사진 px
  w: number; // 길이(가중치)
  kind: 'v' | 'h';
}

const TMAX = Math.tan((20 * Math.PI) / 180); // 축에서 ±20° 안쪽의 선만
const T_STEP = 0.005;

export function detectLines(img: HTMLImageElement): LineSeg[] {
  const W0 = img.naturalWidth, H0 = img.naturalHeight;
  const s = Math.min(1, 1000 / Math.max(W0, H0));
  const W = Math.round(W0 * s), H = Math.round(H0 * s);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  // 흑백 + 3×3 블러
  const g0 = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g0[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const g = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += g0[(y + dy) * W + x + dx];
      g[y * W + x] = sum / 9;
    }

  // Sobel
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H), mag = new Float32Array(W * H);
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      const a = g[i - W - 1], b = g[i - W], c = g[i - W + 1], l = g[i - 1], r = g[i + 1], e = g[i + W - 1], f = g[i + W], h = g[i + W + 1];
      const sx = c + 2 * r + h - a - 2 * l - e;
      const sy = e + 2 * f + h - a - 2 * b - c;
      gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
    }

  // 상위 ~9% 경계만 사용
  const sample: number[] = [];
  for (let i = 0; i < mag.length; i += 7) if (mag[i] > 0) sample.push(mag[i]);
  sample.sort((p, q) => p - q);
  const thr = Math.max(24, sample[Math.floor(sample.length * 0.91)] || 0);

  // 0: 없음, 1: 세로선 위의 점(가로 방향 기울기), 2: 가로선 위의 점
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) {
    if (mag[i] < thr) continue;
    const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
    if (ax > 1.6 * ay) mask[i] = 1;
    else if (ay > 1.6 * ax) mask[i] = 2;
  }

  const out: LineSeg[] = [];
  const family = (kind: 'v' | 'h') => {
    // 세로선: along = y, across = x / 가로선: along = x, across = y
    const L = kind === 'v' ? H : W;   // 선을 따라가는 방향 길이
    const A = kind === 'v' ? W : H;   // 가로지르는 방향 길이
    const code = kind === 'v' ? 1 : 2;
    const at = (along: number, across: number) => (kind === 'v' ? along * W + across : across * W + along);
    const nT = Math.round((2 * TMAX) / T_STEP) + 1;
    const off = Math.round(A * 0.3);
    const nC = A + 2 * off;
    const acc = new Int32Array(nT * nC);
    const half = L / 2;
    for (let along = 0; along < L; along++)
      for (let across = 0; across < A; across++) {
        if (mask[at(along, across)] !== code) continue;
        const da = along - half;
        for (let ti = 0; ti < nT; ti++) {
          const c = Math.round(across - (ti * T_STEP - TMAX) * da) + off;
          if (c >= 0 && c < nC) acc[ti * nC + c]++;
        }
      }
    // 피크 (비최대 억제)
    const minVotes = Math.max(20, Math.round(L * 0.1));
    const cand: { v: number; ti: number; ci: number }[] = [];
    for (let ti = 0; ti < nT; ti++)
      for (let ci = 0; ci < nC; ci++) {
        const v = acc[ti * nC + ci];
        if (v >= minVotes) cand.push({ v, ti, ci });
      }
    cand.sort((p, q) => q.v - p.v);
    const picked: typeof cand = [];
    for (const c of cand) {
      if (picked.length >= 40) break;
      if (picked.some((p) => Math.abs(p.ti - c.ti) <= 6 && Math.abs(p.ci - c.ci) <= 10)) continue;
      picked.push(c);
    }
    // 피크마다 실제로 이어진 가장 긴 선분 찾기
    for (const pk of picked) {
      const t = pk.ti * T_STEP - TMAX, c0 = pk.ci - off;
      let best = { a0: 0, a1: -1 }, runStart = -1, last = -1;
      for (let along = 0; along < L; along++) {
        const across = Math.round(c0 + t * (along - half));
        let hit = false;
        for (let k = -1; k <= 1 && !hit; k++) {
          const ac = across + k;
          if (ac >= 0 && ac < A && mask[at(along, ac)] === code) hit = true;
        }
        if (hit) {
          if (runStart < 0 || along - last > 6) runStart = along;
          last = along;
          if (last - runStart > best.a1 - best.a0) best = { a0: runStart, a1: last };
        }
      }
      const len = best.a1 - best.a0;
      if (len < L * 0.08) continue;
      const p1 = { along: best.a0, across: c0 + t * (best.a0 - half) };
      const p2 = { along: best.a1, across: c0 + t * (best.a1 - half) };
      const toXY = (p: { along: number; across: number }) =>
        kind === 'v' ? { x: p.across / s, y: p.along / s } : { x: p.along / s, y: p.across / s };
      const q1 = toXY(p1), q2 = toXY(p2);
      out.push({ x1: q1.x, y1: q1.y, x2: q2.x, y2: q2.y, w: len / s, kind });
    }
  };
  family('v');
  family('h');
  return out;
}

const CAP = 6; // °: 이보다 많이 벗어난 선은 영향이 커지지 않게 (잘못 잡힌 선 대비)

function deviation(segs: LineSeg[], W: number, H: number, a: Adjust, useH: boolean) {
  const { C } = computeCorrection(W, H, a);
  let sv = 0, wv = 0, sh = 0, wh = 0;
  for (const l of segs) {
    if (l.kind === 'h' && !useH) continue;
    const p = apply(C, { x: l.x1, y: l.y1 }), q = apply(C, { x: l.x2, y: l.y2 });
    const dx = q.x - p.x, dy = q.y - p.y;
    const dev = l.kind === 'v' ? Math.atan(dx / dy) : Math.atan(dy / dx);
    const deg = (dev * 180) / Math.PI;
    const e = Math.min(deg * deg, CAP * CAP);
    if (l.kind === 'v') { sv += l.w * e; wv += l.w; }
    else { sh += l.w * e; wh += l.w; }
  }
  return (wv ? sv / wv : 0) + (useH && wh ? sh / wh : 0);
}

function nelderMead(f: (x: number[]) => number, x0: number[], step: number, iters = 160) {
  const n = x0.length;
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))];
  let vals = pts.map(f);
  for (let k = 0; k < iters; k++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map((i) => pts[i]); vals = order.map((i) => vals[i]);
    if (Math.abs(vals[n] - vals[0]) < 1e-7) break;
    const cen = x0.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p[j], 0) / n);
    const lerp = (a: number[], t: number) => cen.map((c, j) => c + t * (a[j] - c));
    const xr = lerp(pts[n], -1), fr = f(xr);
    if (fr < vals[0]) {
      const xe = lerp(pts[n], -2), fe = f(xe);
      if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { pts[n] = xr; vals[n] = fr; }
    else {
      const xc = lerp(pts[n], 0.5), fc = f(xc);
      if (fc < vals[n]) { pts[n] = xc; vals[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals[i] = f(pts[i]); }
      }
    }
  }
  const bi = vals.indexOf(Math.min(...vals));
  return { x: pts[bi], v: vals[bi] };
}

export interface AutoResult {
  adjust: Adjust;
  vLines: number;
  hLines: number;
}

/**
 * mode 'vertical': 회전 + 수직 원근 (세로선만 사용)
 * mode 'full': 회전 + 수직 원근 + 수평 원근 (세로선 + 가로선)
 */
export function autoStraighten(segs: LineSeg[], W: number, H: number, mode: 'vertical' | 'full'): AutoResult | null {
  const vLines = segs.filter((l) => l.kind === 'v').length;
  const hLines = segs.filter((l) => l.kind === 'h').length;
  if (vLines < 2 || (mode === 'full' && hLines < 2)) return null;
  const full = mode === 'full';
  const clamp = (x: number[]) => [
    Math.max(-15, Math.min(15, x[0])),
    Math.max(-30, Math.min(30, x[1])),
    full ? Math.max(-30, Math.min(30, x[2])) : 0,
  ];
  const f = (x: number[]) => {
    const [r, v, h] = clamp(x);
    // 아주 약한 0 쪽 당김: 근거가 약한 방향으로 과하게 보정하지 않도록
    return deviation(segs, W, H, { rotate: r, vertical: v, horizontal: h }, full) + 0.0004 * (v * v + h * h + r * r);
  };
  // 거친 격자에서 출발점 몇 개 고른 뒤 정밀 탐색
  const starts: { x: number[]; v: number }[] = [];
  const hs = full ? [-20, -10, 0, 10, 20] : [0];
  for (const v of [-20, -10, 0, 10, 20])
    for (const h of hs)
      for (const r of [-4, 0, 4]) {
        const x = full ? [r, v, h] : [r, v];
        starts.push({ x, v: f(full ? x : [...x, 0]) });
      }
  starts.sort((a, b) => a.v - b.v);
  let best = { x: [0, 0, 0], v: Infinity };
  for (const st of starts.slice(0, 4)) {
    const g = full ? f : (x: number[]) => f([x[0], x[1], 0]);
    const res = nelderMead(g, st.x, 2);
    if (res.v < best.v) best = { x: full ? res.x : [res.x[0], res.x[1], 0], v: res.v };
  }
  const [r, v, h] = clamp(best.x).map((n) => Math.round(n * 10) / 10);
  return { adjust: { rotate: r, vertical: v, horizontal: h }, vLines, hLines };
}
