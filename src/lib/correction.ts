// 사진 보정(회전 · 수직/수평 원근): 원본 사진 → 보정된 화면 좌표로 가는 호모그래피 C.
// 가상의 카메라를 다시 돌리는 방식(K·R·K⁻¹)이라 직선은 직선으로 유지된다.
// ※ 기준 설정·배치·측정은 모두 "원본 사진 좌표"에서 계산되므로, 보정 값을 바꿔도 cm 정확도에는 영향이 없다.
import { apply, invert, mul, type Mat3 } from './homography';

export interface Adjust {
  rotate: number; // 기울기(°)
  vertical: number; // 수직 원근(°)
  horizontal: number; // 수평 원근(°)
}

export const noAdjust = (): Adjust => ({ rotate: 0, vertical: 0, horizontal: 0 });
export const isIdentity = (a: Adjust) => !a.rotate && !a.vertical && !a.horizontal;

export interface Correction {
  C: Mat3; // 원본 px → 보정 px
  Cinv: Mat3;
  outW: number;
  outH: number;
  scale: number; // 중심부 배율 (오버레이 선 두께 보정용)
}

const rad = (d: number) => (d * Math.PI) / 180;

export function computeCorrection(W: number, H: number, a: Adjust): Correction {
  if (!W || !H || isIdentity(a)) {
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return { C: I, Cinv: I, outW: W, outH: H, scale: 1 };
  }
  const f = Math.max(W, H); // 일반적인 스마트폰 1× 렌즈 화각에 가까운 초점거리
  const cx = W / 2, cy = H / 2;
  const K = [f, 0, cx, 0, f, cy, 0, 0, 1];
  const Ki = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const p = rad(a.vertical), y = rad(-a.horizontal), r = rad(a.rotate);
  const Rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)];
  const Ry = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
  const Rz = [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  const H0 = mul(K, mul(Rz, mul(Rx, mul(Ry, Ki))));

  // 사진 편집 앱처럼: 결과는 항상 원본과 같은 크기·비율의 직사각형.
  // 변형된 사진 안에 꽉 차는 가장 큰 (원본 비율) 사각형을 찾아 그만큼 확대·자른다 → 빈 모서리 없음
  const quad = [
    { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H },
  ].map((c) => apply(H0, c));
  const ctr = apply(H0, { x: cx, y: cy });
  const inside = (pt: { x: number; y: number }) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const cr = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
      const sg = Math.sign(cr);
      if (sg === 0) continue;
      if (sign === 0) sign = sg;
      else if (sg !== sign) return false;
    }
    return true;
  };
  const fits = (k: number) =>
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sy]) =>
      inside({ x: ctr.x + (sx * k * W) / 2, y: ctr.y + (sy * k * H) / 2 }));
  let lo = 0, hi = 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  const k = lo; // 잘라낼 사각형 = 원본 크기 × k
  const x0 = ctr.x - (k * W) / 2, y0 = ctr.y - (k * H) / 2;
  const M = [1 / k, 0, -x0 / k, 0, 1 / k, -y0 / k, 0, 0, 1];
  const C = mul(M, H0);
  const c0 = apply(C, { x: cx, y: cy });
  const c1 = apply(C, { x: cx + 1, y: cy });
  const c2 = apply(C, { x: cx, y: cy + 1 });
  const det = Math.abs((c1.x - c0.x) * (c2.y - c0.y) - (c2.x - c0.x) * (c1.y - c0.y));
  return {
    C,
    Cinv: invert(C),
    outW: W,
    outH: H,
    scale: Math.sqrt(det),
  };
}
