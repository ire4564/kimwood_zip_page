// 투시 변환(호모그래피) 계산.
// 사진 속 벽은 카메라 각도 때문에 사다리꼴로 찍히므로, 단순 비율(px/cm)로는
// 위치에 따라 오차가 커진다. 기준 액자의 네 모서리로 사진 평면 ↔ 벽 평면(cm)
// 변환을 구해, 벽 위 어느 위치에서든 실제 크기를 정확히 재현한다.

export type Pt = { x: number; y: number };
export type Mat3 = number[]; // 행 우선 3x3 (길이 9)

export function apply(H: Mat3, p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/** 점이 카메라 앞쪽(유효 영역)에 투영되는지 */
export function projW(H: Mat3, p: Pt): number {
  return H[6] * p.x + H[7] * p.y + H[8];
}

export function mul(A: Mat3, B: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return r;
}

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular');
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  return inv;
}

// Hartley 정규화: 수치 안정성을 높여 정확도를 확보
function normalizer(pts: Pt[]): Mat3 {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const md = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / n || 1;
  const s = Math.SQRT2 / md;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) throw new Error('degenerate');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** src → dst 로 보내는 호모그래피 (4점 이상, 최소제곱) */
export function solveHomography(src: Pt[], dst: Pt[]): Mat3 {
  const Ts = normalizer(src);
  const Td = normalizer(dst);
  const s = src.map((p) => apply(Ts, p));
  const d = dst.map((p) => apply(Td, p));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < s.length; k++) {
    const { x, y } = s[k];
    const { x: u, y: v } = d[k];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  const Hn = [...h, 1];
  const H = mul(invert(Td), mul(Hn, Ts));
  return H.map((v) => v / H[8]);
}

export function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 이 사각형이 볼록하고 꼬이지 않았는지 (모서리 순서 오류 검출) */
export function isConvexQuad(q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** CSS matrix3d 문자열 (transform-origin: 0 0 기준) */
export function toMatrix3d(Min: Mat3): string {
  const M = Min.map((v) => v / Min[8]);
  return `matrix3d(${M[0]},${M[3]},0,${M[6]},${M[1]},${M[4]},0,${M[7]},0,0,1,0,${M[2]},${M[5]},0,1)`;
}
