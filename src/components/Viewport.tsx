import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apply, dist, mul, projW, toMatrix3d, type Mat3, type Pt } from '../lib/homography';
import { frameBox, frameCorners, frameLocal, type Frame, type Measurement, type Mode, type Quad } from '../types';
import type { RefFrame } from '../lib/calibrate';
import type { Correction } from '../lib/correction';
import { paintPhoto } from '../lib/export';
import { uid } from '../types';

const K = 10; // 액자 DOM 내부 해상도 (px / cm)
const LOUPE = 168;

type Rect = { x: number; y: number; w: number; h: number };
type Seg = { a: Pt; b: Pt }; // 벽 좌표 cm
type Gap = { a: Pt; b: Pt; v: number };

type Drag =
  | { t: 'pan'; cx: number; cy: number; vx: number; vy: number }
  | { t: 'pinch'; d0: number; mx: number; my: number; vx: number; vy: number; vz: number }
  | { t: 'rect'; start: Pt }
  | { t: 'handle'; i: number; start: Pt; orig: Pt; quad: Quad }
  | { t: 'frame'; frame: Frame; start: Pt }
  | { t: 'rotate'; frame: Frame; c: Pt; a0: number }
  | { t: 'mpt'; id: string; end: 'a' | 'b'; start: Pt; orig: Pt; base: Measurement[] }
  | { t: 'mnew'; id: string; a: Pt; base: Measurement[] };

export interface ViewportHandle {
  fit(): void;
  /** 현재 화면 중앙의 벽 좌표(cm) */
  centerWall(): Pt | null;
  imageEl(): HTMLImageElement | null;
}

interface Props {
  imageUrl: string;
  imageW: number;
  imageH: number;
  mode: Mode;
  /** 지금 편집 중인 기준 액자 */
  activeRef: RefFrame | null;
  refs: RefFrame[];
  /** 벽 위 기준 액자 위치(cm) — 자석 정렬·간격 계산용 */
  refRects: Rect[];
  onActiveRef(id: string): void;
  Hiw: Mat3 | null;
  Hwi: Mat3 | null;
  corr: Correction;
  compare?: boolean;
  canCompare?: boolean;
  onCompare?(v: boolean): void;
  frames: Frame[];
  selectedId: string | null;
  measurements: Measurement[];
  snap: boolean;
  showGrid: boolean;
  opacity: number;
  onCorners(q: Quad | null): void;
  onFrame(id: string, patch: Partial<Frame>): void;
  onDeleteFrame(id: string): void;
  onSelect(id: string | null): void;
  onMeasurements(m: Measurement[]): void;
}

/** cm(내부 단위) → mm 정수 문자열 */
const fmt = (cm: number) => String(Math.round(cm * 10));

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport(p, ref) {
  const box = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const photoRef = useRef<HTMLCanvasElement>(null);
  const [imgReady, setImgReady] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, z: 0.2 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<Drag | null>(null);
  const [loupe, setLoupe] = useState<{ pt: Pt; right: boolean } | null>(null);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);
  const [guides, setGuides] = useState<Seg[]>([]);
  const [rotDeg, setRotDeg] = useState<number | null>(null);
  const [space, setSpace] = useState(false);
  const pRef = useRef(p);
  pRef.current = p;

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !p.imageW) return;
    const { width, height } = el.getBoundingClientRect();
    const { outW, outH } = p.corr;
    const z = Math.min(width / outW, height / outH) * 0.94;
    setView({ z, x: (width - outW * z) / 2, y: (height - outH * z) / 2 });
  }, [p.imageW, p.corr.outW, p.corr.outH]);

  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => {
    fit();
  }, [p.imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // 화면 크기가 바뀌면(회전·창 크기 변경) 다시 맞추기
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = `${el.clientWidth}x${el.clientHeight}`;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      const now = `${el.clientWidth}x${el.clientHeight}`;
      if (now === last) return;
      last = now;
      clearTimeout(t);
      t = window.setTimeout(() => fitRef.current(), 120);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, []);

  const toImg = useCallback((cx: number, cy: number): Pt => {
    const r = box.current!.getBoundingClientRect();
    const v = viewRef.current;
    // 화면 → 보정 좌표 → 원본 사진 좌표
    return apply(pRef.current.corr.Cinv, { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z });
  }, []);

  useImperativeHandle(ref, () => ({
    fit,
    centerWall() {
      if (!p.Hiw || !box.current) return null;
      const r = box.current.getBoundingClientRect();
      return apply(p.Hiw, toImg(r.left + r.width / 2, r.top + r.height / 2));
    },
    imageEl: () => imgRef.current,
  }));

  // 휠: Ctrl/⌘ 또는 핀치 → 확대/축소, 그 외 → 이동
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const z = Math.min(40, Math.max(0.02, v.z * Math.exp(-e.deltaY * 0.01)));
        setView({ z, x: mx - ((mx - v.x) * z) / v.z, y: my - ((my - v.y) * z) / v.z });
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 키보드: 스페이스 이동, 방향키 미세 조정, Delete 삭제
  useEffect(() => {
    const isField = (t: EventTarget | null) =>
      t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (isField(e.target)) return;
      const P = pRef.current;
      if (e.code === 'Space') { setSpace(true); e.preventDefault(); return; }
      const dir: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      if (dir[e.key]) {
        const step = e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1; // 1mm (Shift 10mm, Alt 0.1mm)
        const [dx, dy] = dir[e.key];
        if (P.mode === 'arrange' && P.selectedId) {
          const f = P.frames.find((f) => f.id === P.selectedId);
          if (f) P.onFrame(f.id, { x: +(f.x + dx * step).toFixed(3), y: +(f.y + dy * step).toFixed(3) });
          e.preventDefault();
        } else if (P.mode === 'calibrate' && activeHandleRef.current != null && P.activeRef?.corners) {
          const s = e.shiftKey ? 5 : e.altKey ? 0.25 : 1; // 원본 픽셀 단위
          const q = [...P.activeRef.corners] as Quad;
          const i = activeHandleRef.current;
          q[i] = { x: q[i].x + dx * s, y: q[i].y + dy * s };
          P.onCorners(q);
          e.preventDefault();
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && P.mode === 'arrange' && P.selectedId) {
        P.onDeleteFrame(P.selectedId);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  const activeHandleRef = useRef<number | null>(null);
  activeHandleRef.current = activeHandle;

  // 기준 액자를 장애물/스냅 대상으로 포함
  const refRects: Rect[] = p.Hiw ? p.refRects : [];

  const pxPerCm = (wall: Pt) => {
    if (!p.Hwi) return 1;
    const CH = mul(p.corr.C, p.Hwi);
    return dist(apply(CH, wall), apply(CH, { x: wall.x + 1, y: wall.y })) * viewRef.current.z;
  };

  const snapMove = (f: Frame, x: number, y: number) => {
    const others: Rect[] = p.frames.filter((o) => o.id !== f.id).map(frameBox);
    others.push(...refRects);
    const thr = 8 / pxPerCm({ x, y }); // 화면 8px 이내
    const segs: Seg[] = [];
    const axis = (pos: number, size: number, key: 'x' | 'y') => {
      const mine = [pos, pos + size / 2, pos + size];
      let best: { d: number; t: number; o: Rect } | null = null;
      for (const o of others) {
        const op = key === 'x' ? o.x : o.y;
        const os = key === 'x' ? o.w : o.h;
        for (const t of [op, op + os / 2, op + os])
          for (const m of mine) {
            const d = t - m;
            if (Math.abs(d) < thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t, o };
          }
      }
      return best;
    };
    // 회전한 액자는 바깥 경계 상자로 정렬
    const bb = frameBox({ ...f, x, y });
    const bx = axis(bb.x, bb.w, 'x');
    const by = axis(bb.y, bb.h, 'y');
    const dx = bx ? bx.d : 0, dy = by ? by.d : 0;
    if (bx) {
      const y0 = Math.min(bb.y + dy, bx.o.y), y1 = Math.max(bb.y + dy + bb.h, bx.o.y + bx.o.h);
      segs.push({ a: { x: bx.t, y: y0 - 5 }, b: { x: bx.t, y: y1 + 5 } });
    }
    if (by) {
      const x0 = Math.min(bb.x + dx, by.o.x), x1 = Math.max(bb.x + dx + bb.w, by.o.x + by.o.w);
      segs.push({ a: { x: x0 - 5, y: by.t }, b: { x: x1 + 5, y: by.t } });
    }
    return { x: x + dx, y: y + dy, segs };
  };

  const showLoupe = (pt: Pt, clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    setLoupe({ pt, right: clientX - r.left < LOUPE + 40 });
  };

  // 손가락(포인터) 추적: 두 손가락이면 핀치 확대 + 이동
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const d = drag.current;
    // 한 손가락으로 하던 작업은 취소하고 원래대로
    if (d) {
      const P = pRef.current;
      if (d.t === 'mnew' || d.t === 'mpt') P.onMeasurements(d.base);
      else if (d.t === 'frame') P.onFrame(d.frame.id, { x: d.frame.x, y: d.frame.y });
      else if (d.t === 'rotate') P.onFrame(d.frame.id, { rot: d.frame.rot ?? 0 });
      else if (d.t === 'handle') P.onCorners(d.quad);
      else if (d.t === 'rect') P.onCorners(null);
    }
    setLoupe(null);
    setGuides([]);
    const v = viewRef.current;
    drag.current = {
      t: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: v.x, vy: v.y, vz: v.z,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    pointers.current.set(e.pointerId, local(e));
    try { box.current!.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 등 */ }
    if (pointers.current.size >= 2) return startPinch();
    if (drag.current?.t === 'pinch') return;
    const P = p;
    const el = e.target as HTMLElement;
    const pt = toImg(e.clientX, e.clientY);
    const pan = () => {
      const v = viewRef.current;
      drag.current = { t: 'pan', cx: e.clientX, cy: e.clientY, vx: v.x, vy: v.y };
    };
    if (space || e.button === 1) return pan();

    const handle = el.closest('[data-handle]') as HTMLElement | null;
    const frameEl = el.closest('[data-frame]') as HTMLElement | null;
    const mpt = el.closest('[data-mpt]') as HTMLElement | null;

    if (P.mode === 'straighten') return pan();
    if (P.mode === 'calibrate') {
      const refEl = el.closest('[data-ref]') as HTMLElement | null;
      if (refEl && !handle) {
        P.onActiveRef(refEl.dataset.ref!);
        setActiveHandle(null);
        return;
      }
      const ac = P.activeRef?.corners;
      if (handle && ac) {
        const i = +handle.dataset.handle!;
        setActiveHandle(i);
        drag.current = { t: 'handle', i, start: pt, orig: ac[i], quad: ac };
        showLoupe(ac[i], e.clientX);
        return;
      }
      if (P.activeRef && !ac) {
        drag.current = { t: 'rect', start: pt };
        return;
      }
      setActiveHandle(null);
      return pan();
    }
    if (P.mode === 'arrange') {
      const rotEl = el.closest('[data-rot]') as HTMLElement | null;
      if (rotEl && P.Hiw) {
        const f = P.frames.find((f) => f.id === rotEl.dataset.rot)!;
        const c = { x: f.x + f.w / 2, y: f.y + f.h / 2 };
        const w = apply(P.Hiw, pt);
        drag.current = { t: 'rotate', frame: f, c, a0: Math.atan2(w.y - c.y, w.x - c.x) };
        setRotDeg(f.rot ?? 0);
        return;
      }
      if (frameEl) {
        const id = frameEl.dataset.frame!;
        const f = P.frames.find((f) => f.id === id)!;
        P.onSelect(id);
        if (P.Hiw) drag.current = { t: 'frame', frame: f, start: apply(P.Hiw, pt) };
        return;
      }
      P.onSelect(null);
      return pan();
    }
    if (P.mode === 'measure') {
      if (mpt) {
        const [id, end] = mpt.dataset.mpt!.split(':') as [string, 'a' | 'b'];
        const m = P.measurements.find((m) => m.id === id)!;
        drag.current = { t: 'mpt', id, end, start: pt, orig: m[end], base: P.measurements };
        showLoupe(m[end], e.clientX);
        return;
      }
      const id = uid();
      P.onMeasurements([...P.measurements, { id, a: pt, b: pt }]);
      drag.current = { t: 'mnew', id, a: pt, base: P.measurements };
      showLoupe(pt, e.clientX);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, local(e));
    const d = drag.current;
    if (!d) return;
    if (d.t === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const z = Math.min(40, Math.max(0.02, d.vz * (Math.hypot(a.x - b.x, a.y - b.y) / d.d0)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // 처음 두 손가락 가운데에 있던 지점이 지금 가운데를 따라오도록
      const cx = (d.mx - d.vx) / d.vz, cy = (d.my - d.vy) / d.vz;
      setView({ z, x: mx - cx * z, y: my - cy * z });
      return;
    }
    const P = p;
    const pt = toImg(e.clientX, e.clientY);
    switch (d.t) {
      case 'pan':
        setView((v) => ({ ...v, x: d.vx + e.clientX - d.cx, y: d.vy + e.clientY - d.cy }));
        break;
      case 'rect': {
        // 화면(보정된 좌표)에서 보이는 그대로의 직사각형 → 원본 사진 좌표로 변환
        const s0 = apply(P.corr.C, d.start), s1 = apply(P.corr.C, pt);
        const x0 = Math.min(s0.x, s1.x), x1 = Math.max(s0.x, s1.x);
        const y0 = Math.min(s0.y, s1.y), y1 = Math.max(s0.y, s1.y);
        const back = (x: number, y: number) => apply(P.corr.Cinv, { x, y });
        P.onCorners([back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)]);
        break;
      }
      case 'handle': {
        // 커서가 아닌 이동량을 적용 → 손가락/커서가 모서리를 가리지 않음
        const np = { x: d.orig.x + pt.x - d.start.x, y: d.orig.y + pt.y - d.start.y };
        const q = [...d.quad] as Quad;
        q[d.i] = np;
        P.onCorners(q);
        showLoupe(np, e.clientX);
        break;
      }
      case 'frame': {
        if (!P.Hiw) break;
        const w = apply(P.Hiw, pt);
        const f = d.frame;
        let x = f.x + w.x - d.start.x;
        let y = f.y + w.y - d.start.y;
        let segs: Seg[] = [];
        if (P.snap && !e.altKey) ({ x, y, segs } = snapMove(f, x, y));
        setGuides(segs);
        P.onFrame(f.id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
        break;
      }
      case 'rotate': {
        if (!P.Hiw) break;
        const w = apply(P.Hiw, pt);
        let deg = (d.frame.rot ?? 0) + ((Math.atan2(w.y - d.c.y, w.x - d.c.x) - d.a0) * 180) / Math.PI;
        deg = ((deg + 540) % 360) - 180; // −180 ~ 180
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // Shift: 15° 단위
        else if (!e.altKey) {
          const near = Math.round(deg / 90) * 90; // 0·90·180°에 3° 이내면 붙기
          if (Math.abs(deg - near) < 3) deg = near;
        }
        deg = Math.round(deg * 10) / 10;
        if (Object.is(deg, -0) || deg === -180) deg = Math.abs(deg);
        setRotDeg(deg);
        P.onFrame(d.frame.id, { rot: deg });
        break;
      }
      case 'mpt': {
        const np = { x: d.orig.x + pt.x - d.start.x, y: d.orig.y + pt.y - d.start.y };
        P.onMeasurements(d.base.map((m) => (m.id === d.id ? { ...m, [d.end]: np } : m)));
        showLoupe(np, e.clientX);
        break;
      }
      case 'mnew':
        P.onMeasurements([...d.base, { id: d.id, a: d.a, b: pt }]);
        showLoupe(pt, e.clientX);
        break;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d?.t === 'pinch') {
      if (pointers.current.size < 2) drag.current = null; // 남은 손가락으로 새 작업 시작하지 않음
      return;
    }
    if (d && d.t !== 'pan' && e.type === 'pointerup') onPointerMove(e); // 마지막 위치 반영
    drag.current = null;
    setLoupe(null);
    setGuides([]);
    setRotDeg(null);
    if (!d) return;
    const end = toImg(e.clientX, e.clientY);
    if (d.t === 'rect' && (Math.abs(end.x - d.start.x) < 4 || Math.abs(end.y - d.start.y) < 4)) p.onCorners(null);
    if (d.t === 'mnew' && dist(d.a, end) * viewRef.current.z * p.corr.scale < 4) p.onMeasurements(d.base);
  };

  // 돋보기 렌더링
  useEffect(() => {
    if (!loupe || !loupeRef.current || !imgRef.current) return;
    const c = loupeRef.current;
    const dpr = window.devicePixelRatio || 1;
    c.width = LOUPE * dpr;
    c.height = LOUPE * dpr;
    const ctx = c.getContext('2d')!;
    const mag = Math.max(3, view.z * 4) * dpr; // 원본 1px 당 캔버스 px
    ctx.imageSmoothingEnabled = mag < 6 * dpr;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, c.width, c.height);
    // 보정(C)의 국소 선형 근사로 화면과 같은 방향으로 확대
    const C = p.corr.C, pt = loupe.pt;
    const c0 = apply(C, pt), c1 = apply(C, { x: pt.x + 1, y: pt.y }), c2 = apply(C, { x: pt.x, y: pt.y + 1 });
    const k = mag / p.corr.scale;
    const a = (c1.x - c0.x) * k, b = (c1.y - c0.y) * k, cc = (c2.x - c0.x) * k, d = (c2.y - c0.y) * k;
    const h = c.width / 2;
    ctx.save();
    ctx.setTransform(a, b, cc, d, h - (a * pt.x + cc * pt.y), h - (b * pt.x + d * pt.y));
    ctx.drawImage(imgRef.current, 0, 0);
    ctx.restore();
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = dpr;
    const m = c.width / 2;
    ctx.beginPath();
    ctx.moveTo(m, 0); ctx.lineTo(m, m - 6 * dpr);
    ctx.moveTo(m, m + 6 * dpr); ctx.lineTo(m, c.height);
    ctx.moveTo(0, m); ctx.lineTo(m - 6 * dpr, m);
    ctx.moveTo(m + 6 * dpr, m); ctx.lineTo(c.width, m);
    ctx.stroke();
  }, [loupe, view.z, p.corr]);

  // 보정된 사진을 캔버스에 그리기 (CSS 3D 변형 대신 → 큰 사진에서도 검은 면/깨짐 없음)
  useEffect(() => {
    const img = imgRef.current, cv = photoRef.current;
    if (!img || !cv || !img.complete || !img.naturalWidth) return;
    const id = requestAnimationFrame(() => paintPhoto(img, p.corr, cv));
    return () => cancelAnimationFrame(id);
  }, [p.corr, imgReady]);

  // ---- 그리기용 계산 (모든 좌표는 '보정된 화면 좌표'로 투영해서 그림) ----
  const z = view.z;
  const Hwi = p.Hwi;
  const CH = useMemo(() => (Hwi ? mul(p.corr.C, Hwi) : null), [Hwi, p.corr]); // 벽 cm → 보정 화면 px
  const W = (pt: Pt) => apply(CH!, pt);
  const Cp = (pt: Pt) => apply(p.corr.C, pt); // 원본 사진 px → 보정 화면 px

  const gridLines = useMemo(() => {
    if (!p.showGrid || !p.Hiw || !p.Hwi) return [];
    const corners = [
      { x: 0, y: 0 }, { x: p.imageW, y: 0 }, { x: p.imageW, y: p.imageH }, { x: 0, y: p.imageH },
    ];
    if (corners.some((c) => projW(p.Hiw!, c) <= 0)) return [];
    const wc = corners.map((c) => apply(p.Hiw!, c));
    const cl = (v: number) => Math.max(-3000, Math.min(3000, v));
    const minX = cl(Math.min(...wc.map((c) => c.x))), maxX = cl(Math.max(...wc.map((c) => c.x)));
    const minY = cl(Math.min(...wc.map((c) => c.y))), maxY = cl(Math.max(...wc.map((c) => c.y)));
    const lines: { a: Pt; b: Pt; major: boolean }[] = [];
    const step = 10;
    for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step)
      lines.push({ a: apply(CH!, { x, y: minY }), b: apply(CH!, { x, y: maxY }), major: x % 50 === 0 });
    for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step)
      lines.push({ a: apply(CH!, { x: minX, y }), b: apply(CH!, { x: maxX, y }), major: y % 50 === 0 });
    return lines;
  }, [p.showGrid, p.Hiw, p.Hwi, CH, p.imageW, p.imageH]);

  const selected = p.frames.find((f) => f.id === p.selectedId) || null;

  const gaps: Gap[] = useMemo(() => {
    if (!selected || !Hwi || p.mode !== 'arrange') return [];
    const S = frameBox(selected);
    const obs: Rect[] = p.frames.filter((o) => o.id !== selected.id).map(frameBox);
    obs.push(...refRects);
    const out: Gap[] = [];
    const best: Record<string, { v: number; o: Rect } | null> = { l: null, r: null, u: null, d: null };
    for (const o of obs) {
      const vOverlap = o.y < S.y + S.h && o.y + o.h > S.y;
      const hOverlap = o.x < S.x + S.w && o.x + o.w > S.x;
      if (vOverlap) {
        const r = o.x - (S.x + S.w);
        if (r >= -0.01 && (!best.r || r < best.r.v)) best.r = { v: r, o };
        const l = S.x - (o.x + o.w);
        if (l >= -0.01 && (!best.l || l < best.l.v)) best.l = { v: l, o };
      }
      if (hOverlap) {
        const d = o.y - (S.y + S.h);
        if (d >= -0.01 && (!best.d || d < best.d.v)) best.d = { v: d, o };
        const u = S.y - (o.y + o.h);
        if (u >= -0.01 && (!best.u || u < best.u.v)) best.u = { v: u, o };
      }
    }
    const midY = (o: Rect) => (Math.max(S.y, o.y) + Math.min(S.y + S.h, o.y + o.h)) / 2;
    const midX = (o: Rect) => (Math.max(S.x, o.x) + Math.min(S.x + S.w, o.x + o.w)) / 2;
    if (best.r) { const y = midY(best.r.o); out.push({ a: { x: S.x + S.w, y }, b: { x: best.r.o.x, y }, v: best.r.v }); }
    if (best.l) { const y = midY(best.l.o); out.push({ a: { x: best.l.o.x + best.l.o.w, y }, b: { x: S.x, y }, v: best.l.v }); }
    if (best.d) { const x = midX(best.d.o); out.push({ a: { x, y: S.y + S.h }, b: { x, y: best.d.o.y }, v: best.d.v }); }
    if (best.u) { const x = midX(best.u.o); out.push({ a: { x, y: best.u.o.y + best.u.o.h }, b: { x, y: S.y }, v: best.u.v }); }
    return out.filter((g) => g.v > 0.05);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, p.frames, Hwi, p.mode, p.refRects]);

  const label = (at: Pt, text: string, color = '#1d1b19', key?: string | number) => (
    <text
      key={key}
      x={at.x}
      y={at.y}
      fontSize={11 / z}
      fill={color}
      stroke="#fff"
      strokeWidth={3.5 / z}
      paintOrder="stroke"
      textAnchor="middle"
      dominantBaseline="central"
      fontWeight={600}
    >
      {text}
    </text>
  );

  const q = p.activeRef?.corners ?? null;
  const qs = q ? (q.map(Cp) as Quad) : null;
  const ptsStr = (pts: Pt[]) => pts.map((v) => `${v.x},${v.y}`).join(' ');
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const cursor = drag.current?.t === 'pan' ? 'grabbing' : space ? 'grab'
    : p.mode === 'measure' || (p.mode === 'calibrate' && !q) ? 'crosshair' : 'default';

  return (
    <div
      className="viewport"
      ref={box}
      style={{ cursor, ['--ar' as string]: p.corr.outW / p.corr.outH } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="stage"
        style={{ width: p.corr.outW, height: p.corr.outH, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
      >
        <img ref={imgRef} src={p.imageUrl} className="src-img" draggable={false} alt="" onLoad={() => setImgReady((n) => n + 1)} />
        <canvas ref={photoRef} className="photo-canvas" style={{ width: p.corr.outW, height: p.corr.outH }} />

        {gridLines.length > 0 && (
          <svg className="overlay" viewBox={`0 0 ${p.corr.outW} ${p.corr.outH}`} width={p.corr.outW} height={p.corr.outH}>
            {gridLines.map((l, i) => (
              <line key={i} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y}
                stroke={l.major ? 'rgba(0,120,255,0.55)' : 'rgba(0,120,255,0.22)'} strokeWidth={(l.major ? 1.2 : 0.8) / z} />
            ))}
          </svg>
        )}

        {Hwi && (p.mode === 'arrange' || p.mode === 'measure') && (
          <div className="frames-layer" style={{ pointerEvents: p.mode === 'arrange' ? 'auto' : 'none' }}>
            {p.frames.map((f) => (
              <div
                key={f.id}
                data-frame={f.id}
                className="frame"
                style={{
                  width: f.w * K,
                  height: f.h * K,
                  padding: f.border * K,
                  background: f.color,
                  opacity: p.opacity,
                  boxShadow: `0 ${0.4 * K}px ${1.4 * K}px rgba(0,0,0,0.3)`,
                  transform: toMatrix3d(mul(CH!, mul(frameLocal(f), [1 / K, 0, 0, 0, 1 / K, 0, 0, 0, 1]))),
                }}
              >
                <div className="mat" style={{ padding: f.mat * K, background: f.matColor }}>
                  {f.art ? (
                    <img src={f.art} alt="" draggable={false} />
                  ) : (
                    <div className="ph" style={{ fontSize: Math.max(12, Math.min(f.w, f.h) * K * 0.07) }}>
                      <b>{f.name}</b>
                      <span>{fmt(f.w)} × {fmt(f.h)} mm</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <svg className="overlay" viewBox={`0 0 ${p.corr.outW} ${p.corr.outH}`} width={p.corr.outW} height={p.corr.outH}>
          {/* 보정용 격자 (사진 위에만, 사진 편집 앱처럼) */}
          {p.mode === 'straighten' && (() => {
            const n = 12, cell = p.corr.outW / n, rows = Math.round(p.corr.outH / cell);
            const ls: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
            for (let i = 1; i < n; i++) ls.push({ x1: i * cell, y1: 0, x2: i * cell, y2: p.corr.outH, major: i % 4 === 0 });
            for (let j = 1; j < rows; j++) { const y = (j * p.corr.outH) / rows; ls.push({ x1: 0, y1: y, x2: p.corr.outW, y2: y, major: rows % 3 === 0 && j % (rows / 3) === 0 }); }
            return ls.map(({ major, ...l }, i) => (
              <g key={i}>
                <line {...l} stroke="rgba(0,0,0,0.25)" strokeWidth={(major ? 2 : 1.4) / z} />
                <line {...l} stroke={major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)'} strokeWidth={(major ? 1 : 0.7) / z} />
              </g>
            ));
          })()}

          {/* 기준 액자들 (편집 중이 아닌 것) — 보정 단계에선 클릭해서 선택 */}
          {p.refs.filter((r) => r.corners && (p.mode !== 'calibrate' || r.id !== p.activeRef?.id)).map((r) => {
            const s = r.corners!.map(Cp);
            const c = { x: (s[0].x + s[2].x) / 2, y: (s[0].y + s[2].y) / 2 };
            const cal = p.mode === 'calibrate';
            return (
              <g key={r.id} data-ref={r.id} className={cal ? 'hit' : ''} style={cal ? { cursor: 'pointer' } : undefined}>
                <polygon points={ptsStr(s)} fill={cal ? 'rgba(255,149,0,0.08)' : 'none'} stroke="#FF9500"
                  strokeWidth={(cal ? 1.5 : 1.2) / z} strokeDasharray={`${6 / z} ${4 / z}`} opacity={cal ? 0.9 : 0.6} />
                {cal && label(c, r.name, '#C93400')}
              </g>
            );
          })}

          {/* 편집 중인 기준 액자 */}
          {p.mode === 'calibrate' && q && qs && p.activeRef && (
            <g>
              <polygon points={ptsStr(qs)} fill="rgba(255,149,0,0.14)" stroke="#FF9500" strokeWidth={2 / z} />
              {label({ x: (qs[0].x + qs[2].x) / 2, y: (qs[0].y + qs[2].y) / 2 }, p.activeRef.name, '#C93400')}
              {p.activeRef.widthCm > 0 && label(
                { x: mid(qs[0], qs[1]).x, y: mid(qs[0], qs[1]).y - 14 / z }, `${fmt(p.activeRef.widthCm)} mm`, '#C93400')}
              {p.activeRef.heightCm > 0 && label(
                { x: mid(qs[0], qs[3]).x - 30 / z, y: mid(qs[0], qs[3]).y }, `${fmt(p.activeRef.heightCm)} mm`, '#C93400')}
              {qs.map((c, i) => (
                <g key={i} data-handle={i} className="hit">
                  <circle cx={c.x} cy={c.y} r={14 / z} fill="transparent" />
                  <circle cx={c.x} cy={c.y} r={6 / z} fill={activeHandle === i ? '#FF9500' : '#fff'} stroke="#FF9500" strokeWidth={2 / z} />
                  <circle cx={c.x} cy={c.y} r={0.9 / z} fill="#FF9500" />
                </g>
              ))}
            </g>
          )}

          {/* 선택 액자 표시 + 치수 */}
          {Hwi && selected && p.mode === 'arrange' && (() => {
            const pts = frameCorners(selected).map(W);
            const c = W({ x: selected.x + selected.w / 2, y: selected.y + selected.h / 2 });
            return (
              <g>
                <polygon points={ptsStr(pts)} fill="none" stroke="#007AFF" strokeWidth={2 / z} />
                {/* 모서리 바깥쪽: 드래그하면 회전 */}
                {pts.map((q, i) => {
                  const dx = q.x - c.x, dy = q.y - c.y, l = Math.hypot(dx, dy) || 1;
                  const h = { x: q.x + (dx / l) * 12 / z, y: q.y + (dy / l) * 12 / z };
                  return (
                    <g key={i}>
                      <circle cx={h.x} cy={h.y} r={14 / z} fill="transparent" className="hit rot" data-rot={selected.id} />
                      <circle cx={q.x} cy={q.y} r={3.5 / z} fill="#fff" stroke="#007AFF" strokeWidth={1.5 / z} pointerEvents="none" />
                    </g>
                  );
                })}
                {rotDeg !== null && label(c, `${rotDeg.toFixed(1)}°`, '#0062CC')}
                {label({ x: mid(pts[0], pts[1]).x, y: mid(pts[0], pts[1]).y - 13 / z }, `${fmt(selected.w)} mm`, '#0062CC')}
                {label({ x: mid(pts[0], pts[3]).x - 26 / z, y: mid(pts[0], pts[3]).y }, `${fmt(selected.h)} mm`, '#0062CC')}
              </g>
            );
          })()}

          {/* 간격 */}
          {Hwi && gaps.map((g, i) => {
            const a = W(g.a), b = W(g.b);
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#FF2D55" strokeWidth={1.2 / z} strokeDasharray={`${4 / z} ${3 / z}`} />
                {label(mid(a, b), `${fmt(g.v)}`, '#D70015')}
              </g>
            );
          })}

          {/* 스냅 가이드 */}
          {Hwi && guides.map((g, i) => {
            const a = W(g.a), b = W(g.b);
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#FF2D55" strokeWidth={1 / z} />;
          })}

          {/* 측정 */}
          {p.Hiw && p.mode === 'measure' && p.measurements.map((m) => {
            const d = dist(apply(p.Hiw!, m.a), apply(p.Hiw!, m.b));
            const ms = { a: Cp(m.a), b: Cp(m.b) };
            return (
              <g key={m.id}>
                <line x1={ms.a.x} y1={ms.a.y} x2={ms.b.x} y2={ms.b.y} stroke="#34C759" strokeWidth={2 / z} />
                {(['a', 'b'] as const).map((k) => (
                  <g key={k} data-mpt={`${m.id}:${k}`} className="hit">
                    <circle cx={ms[k].x} cy={ms[k].y} r={12 / z} fill="transparent" />
                    <circle cx={ms[k].x} cy={ms[k].y} r={4.5 / z} fill="#fff" stroke="#34C759" strokeWidth={2 / z} />
                  </g>
                ))}
                {label({ x: mid(ms.a, ms.b).x, y: mid(ms.a, ms.b).y - 12 / z }, `${fmt(d)} mm`, '#248A3D')}
              </g>
            );
          })}
        </svg>
      </div>


      {loupe && (
        <canvas ref={loupeRef} className={`loupe ${loupe.right ? 'right' : ''}`} style={{ width: LOUPE, height: LOUPE }} />
      )}

      {p.mode === 'straighten' && p.onCompare && (() => {
        const bh = box.current?.clientHeight ?? 9999;
        const bw = box.current?.clientWidth ?? 9999;
        const left = Math.min(Math.max(12, view.x + 12), bw - 60);
        const top = Math.max(12, Math.min(bh - 56, view.y + p.corr.outH * view.z - 52));
        return (
          <button
            className={`compare-btn ${p.compare ? 'on' : ''}`}
            style={{ left, top }}
            disabled={!p.canCompare}
            title="보정 전/후 비교"
            aria-label="보정 전/후 비교"
            aria-pressed={!!p.compare}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => p.onCompare!(!p.compare)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M12 2.5v19" />
              <path d="M3.8 19.2 12 11" opacity="0" />
              <path d="M12 4h6.5A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H12z" fill="currentColor" stroke="none" opacity="0.28" />
            </svg>
            {p.compare && <span>보정 전</span>}
          </button>
        );
      })()}

      <div className="zoom-ctl" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => {
          const r = box.current!.getBoundingClientRect();
          const mx = r.width / 2, my = r.height / 2;
          setView((v) => { const z = Math.min(40, v.z * 1.4); return { z, x: mx - ((mx - v.x) * z) / v.z, y: my - ((my - v.y) * z) / v.z }; });
        }}>+</button>
        <button onClick={() => {
          const r = box.current!.getBoundingClientRect();
          const mx = r.width / 2, my = r.height / 2;
          setView((v) => { const z = Math.max(0.02, v.z / 1.4); return { z, x: mx - ((mx - v.x) * z) / v.z, y: my - ((my - v.y) * z) / v.z }; });
        }}>−</button>
        <button onClick={fit} title="화면에 맞추기">⤢</button>
        <span>{Math.round(z * 100)}%</span>
      </div>
    </div>
  );
});
