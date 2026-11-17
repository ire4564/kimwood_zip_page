import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewport, type ViewportHandle } from './components/Viewport';
import { ArrangePanel, CalibratePanel, MeasurePanel, StraightenPanel } from './components/Panels';
import { solveCalibration, poseCorners, type RefFrame } from './lib/calibrate';
import { computeCorrection, isIdentity, noAdjust } from './lib/correction';
import { blobToDataURL, dataURLToBlob, idbGet, idbSet, loadImage } from './lib/storage';
import { exportPNG } from './lib/export';
import { useHistory } from './lib/useHistory';
import { emptyProject, newRef, normalizeCal, uid, type Calibration, type Frame, type Mode, type Project, type Quad } from './types';

const KEY = 'project-v1';

const STEPS: { id: Mode; label: string }[] = [
  { id: 'straighten', label: '사진 보정' },
  { id: 'calibrate', label: '기준 지정' },
  { id: 'arrange', label: '액자 배치' },
  { id: 'measure', label: '길이 측정' },
];

export default function App() {
  const [proj, setProj] = useState<Project>(emptyProject);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('straighten');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [opacity, setOpacity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  const vp = useRef<ViewportHandle>(null);
  const [compare, setCompare] = useState(false);
  const [showPcNote, setShowPcNote] = useState(() => {
    try { return localStorage.getItem('pcNoteClosed') !== '1'; } catch { return true; }
  });

  // ── 페이지별 되돌리기 (⌘/Ctrl+Z): 각 단계는 자기 설정값만 되돌린다
  const hAdjust = useHistory(proj.adjust, (v) => setProj((p) => ({ ...p, adjust: v })), loaded);
  const hCal = useHistory(proj.calibration, (v) => setProj((p) => ({ ...p, calibration: v })), loaded);
  const hFrames = useHistory(proj.frames, (v) => setProj((p) => ({ ...p, frames: v })), loaded);
  const hMeas = useHistory(proj.measurements, (v) => setProj((p) => ({ ...p, measurements: v })), loaded);
  const histories = { straighten: hAdjust, calibrate: hCal, arrange: hFrames, measure: hMeas };
  const resetHistory = () => Object.values(histories).forEach((h) => h.reset());
  const histRef = useRef(histories);
  histRef.current = histories;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text'))) return;
      const k = e.key.toLowerCase();
      const h = histRef.current[modeRef.current];
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); h.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); h.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (mode !== 'straighten') setCompare(false); }, [mode]);

  // 불러오기 / 자동 저장
  useEffect(() => {
    idbGet<Project>(KEY).then((p) => {
      if (p && p.imageBlob) {
        const calibration = normalizeCal(p.calibration);
        setProj({ ...emptyProject(), ...p, calibration, adjust: { ...noAdjust(), ...p.adjust } });
        if (solveCalibration(calibration.refs)) setMode('arrange');
      }
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => idbSet(KEY, proj), 400);
    return () => clearTimeout(t);
  }, [proj, loaded]);

  const imageUrl = useMemo(() => (proj.imageBlob ? URL.createObjectURL(proj.imageBlob) : ''), [proj.imageBlob]);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  const corr = useMemo(
    () => computeCorrection(proj.imageW, proj.imageH, proj.adjust),
    [proj.imageW, proj.imageH, proj.adjust],
  );
  const identityCorr = useMemo(() => computeCorrection(proj.imageW, proj.imageH, noAdjust()), [proj.imageW, proj.imageH]);

  const cal = proj.calibration;
  // 모든 기준 액자를 함께 써서 원근·축척을 추정 (번들 조정)
  const sol = useMemo(() => {
    try { return solveCalibration(cal.refs); } catch { return null; }
  }, [cal.refs]);
  const Hiw = sol?.Hiw ?? null;
  const Hwi = sol?.Hwi ?? null;
  const refRects = useMemo(() => {
    if (!sol) return [];
    return sol.poses.map((pose) => {
      const r = cal.refs.find((x) => x.id === pose.id)!;
      const c = poseCorners(r, pose);
      const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    });
  }, [sol, cal.refs]);
  const activeRef = cal.refs.find((r) => r.id === activeRefId) ?? cal.refs[0] ?? null;

  const setCal = (c: Partial<Calibration>) =>
    setProj((p) => ({ ...p, calibration: { ...p.calibration, ...c } }));
  const updateRef = useCallback((id: string, patch: Partial<RefFrame>) =>
    setProj((p) => ({ ...p, calibration: { ...p.calibration, refs: p.calibration.refs.map((r) => (r.id === id ? { ...r, ...patch } : r)) } })), []);
  const addRef = () => {
    const r = newRef(cal.refs.length + 1);
    setCal({ refs: [...cal.refs, r] });
    setActiveRefId(r.id);
  };
  const removeRef = (id: string) => {
    if (cal.refs.length <= 1) return;
    if (cal.refs[0].id === id && !confirm('첫 번째 기준은 벽 좌표의 원점이에요. 지우면 다음 기준이 원점이 되어 배치한 액자 위치가 바뀔 수 있어요. 지울까요?')) return;
    setCal({ refs: cal.refs.filter((r) => r.id !== id) });
    setActiveRefId(null);
  };
  const updateFrame = useCallback((id: string, patch: Partial<Frame>) =>
    setProj((p) => ({ ...p, frames: p.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)) })), []);
  const deleteFrame = useCallback((id: string) => {
    setProj((p) => ({ ...p, frames: p.frames.filter((f) => f.id !== id) }));
    setSelectedId(null);
  }, []);

  const addFrame = (w: number, h: number, name: string) => {
    const c = vp.current?.centerWall() ?? { x: (cal.refs[0]?.widthCm || 0) + 10 + w / 2, y: h / 2 };
    const f: Frame = {
      id: uid(), name, w, h,
      x: Math.round((c.x - w / 2) * 10) / 10,
      y: Math.round((c.y - h / 2) * 10) / 10,
      border: 2, color: '#1f1c1a', mat: 0, matColor: '#ffffff', art: null,
    };
    setProj((p) => ({ ...p, frames: [...p.frames, f] }));
    setSelectedId(f.id);
  };
  const duplicate = (id: string) => {
    const f = proj.frames.find((f) => f.id === id);
    if (!f) return;
    const n = { ...f, id: uid(), name: f.name + ' 복사', x: f.x + f.w + 5 };
    setProj((p) => ({ ...p, frames: [...p.frames, n] }));
    setSelectedId(n.id);
  };

  const onPhoto = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      resetHistory();
      setProj((p) => ({
        ...p,
        imageBlob: file,
        imageW: img.naturalWidth,
        imageH: img.naturalHeight,
        adjust: noAdjust(),
        calibration: { ...p.calibration, refs: p.calibration.refs.map((r) => ({ ...r, corners: null })) },
        measurements: [],
      }));
      setMode('straighten');
      setSelectedId(null);
    } catch {
      alert('이 이미지 형식을 열 수 없어요. (HEIC는 JPG로 변환해서 올려주세요)');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const doExport = async () => {
    const img = vp.current?.imageEl();
    if (!img || !Hwi) return;
    setBusy(true);
    try {
      const blob = await exportPNG(img, proj.frames, Hwi, opacity, corr);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'wall-layout.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } finally {
      setBusy(false);
    }
  };

  const saveJSON = async () => {
    if (!proj.imageBlob) return;
    const data = { ...proj, imageBlob: undefined, image: await blobToDataURL(proj.imageBlob), version: 1 };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = 'wall-project.json';
    a.click();
  };
  const loadJSON = async (file: File) => {
    try {
      const d = JSON.parse(await file.text());
      const blob = await dataURLToBlob(d.image);
      const calibration = normalizeCal(d.calibration);
      resetHistory();
      setProj({ ...emptyProject(), ...d, calibration, adjust: { ...noAdjust(), ...d.adjust }, imageBlob: blob, image: undefined });
      setMode(solveCalibration(calibration.refs) ? 'arrange' : 'straighten');
      setSelectedId(null);
    } catch {
      alert('프로젝트 파일을 읽을 수 없어요.');
    }
  };

  const done: Record<Mode, boolean> = {
    straighten: !isIdentity(proj.adjust) || !!Hwi,
    calibrate: !!Hwi,
    arrange: proj.frames.length > 0,
    measure: false,
  };
  const reachable = (m: Mode) => !!proj.imageBlob && (m === 'straighten' || m === 'calibrate' || !!Hwi);

  if (!loaded) return null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-text">
            <span className="brand-name">Wall Fit</span>
            <span className="brand-sub">실측 액자 배치 시뮬레이터</span>
          </div>
        </div>

        <nav className="sidenav">
          <label className={`sidenav-item is-clickable ${!proj.imageBlob ? 'is-active' : 'is-done'}`}>
            <span className="nav-num">01</span>
            <span className="nav-label">{proj.imageBlob ? '사진 바꾸기' : '벽 사진 올리기'}</span>
            {proj.imageBlob && <svg className="nav-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="완료"><path d="M3.5 8.5l3 3 6-7" /></svg>}
            <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ''; }} />
          </label>
          {STEPS.map((s, i) => {
            const active = proj.imageBlob && mode === s.id;
            const can = reachable(s.id);
            return (
              <button
                key={s.id}
                disabled={!can}
                className={`sidenav-item ${active ? 'is-active' : ''} ${can ? 'is-clickable' : ''} ${done[s.id] && !active ? 'is-done' : ''}`}
                onClick={() => setMode(s.id)}
              >
                <span className="nav-num">{String(i + 2).padStart(2, '0')}</span>
                <span className="nav-label">{s.label}</span>
                {done[s.id] && !active && <svg className="nav-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="완료"><path d="M3.5 8.5l3 3 6-7" /></svg>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <button className="btn-primary block" disabled={!Hwi || busy} onClick={doExport}>
            {busy ? '저장 중…' : 'PNG로 저장'}
          </button>
          <div className="side-links">
            <button disabled={!proj.imageBlob} onClick={saveJSON}>프로젝트 저장</button>
            <label>프로젝트 열기
              <input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadJSON(f); e.target.value = ''; }} />
            </label>
            <button className="danger" disabled={!proj.imageBlob} onClick={() => {
              if (confirm('사진과 배치를 모두 지울까요?')) { resetHistory(); setProj(emptyProject()); setSelectedId(null); setMode('straighten'); }
            }}>초기화</button>
          </div>
          <div className="sidebar-foot">사진은 이 브라우저에만 저장돼요</div>
        </div>
        {showPcNote && (
          <div className="pc-note" role="note">
            <span>PC 사용을 권장해요. 큰 화면과 마우스로 모서리를 더 정확하게 지정할 수 있어요.</span>
            <button aria-label="안내 닫기" onClick={() => { setShowPcNote(false); try { localStorage.setItem('pcNoteClosed', '1'); } catch { /* 저장 불가 환경 */ } }}>✕</button>
          </div>
        )}
      </aside>

      {!proj.imageBlob ? (
        <Landing onPhoto={onPhoto} />
      ) : (
        <main className="work">
          <Viewport
            ref={vp}
            imageUrl={imageUrl}
            imageW={proj.imageW}
            imageH={proj.imageH}
            mode={mode}
            activeRef={mode === 'calibrate' ? activeRef : null}
            refs={cal.refs}
            refRects={refRects}
            onActiveRef={setActiveRefId}
            Hiw={Hiw}
            Hwi={Hwi}
            corr={compare ? identityCorr : corr}
            compare={compare}
            canCompare={!isIdentity(proj.adjust)}
            onCompare={setCompare}
            frames={proj.frames}
            selectedId={selectedId}
            measurements={proj.measurements}
            snap={snap}
            showGrid={showGrid || (mode === 'calibrate' && !!Hwi)}
            opacity={opacity}
            onCorners={(q: Quad | null) => activeRef && updateRef(activeRef.id, { corners: q })}
            onFrame={updateFrame}
            onDeleteFrame={deleteFrame}
            onSelect={setSelectedId}
            onMeasurements={(m) => setProj((p) => ({ ...p, measurements: m }))}
          />
          <section className="inspector">
            <div className="insp-scroll">
              {mode === 'straighten' && (
                <StraightenPanel adjust={proj.adjust} setAdjust={(a) => setProj((p) => ({ ...p, adjust: a }))} onNext={() => setMode('calibrate')} />
              )}
              {mode === 'calibrate' && (
                <CalibratePanel
                  cal={cal} sol={sol} activeId={activeRef?.id ?? null} setActive={setActiveRefId}
                  updateRef={updateRef} addRef={addRef} removeRef={removeRef} onDone={() => setMode('arrange')}
                />
              )}
              {mode === 'arrange' && (
                <ArrangePanel
                  frames={proj.frames} selectedId={selectedId}
                  onAdd={addFrame} onUpdate={updateFrame} onDelete={deleteFrame} onDuplicate={duplicate} onSelect={setSelectedId}
                  snap={snap} setSnap={setSnap} showGrid={showGrid} setShowGrid={setShowGrid} opacity={opacity} setOpacity={setOpacity}
                />
              )}
              {mode === 'measure' && (
                <MeasurePanel list={proj.measurements} Hiw={Hiw} onChange={(m) => setProj((p) => ({ ...p, measurements: m }))} />
              )}
            </div>
            <p className="hint"><kbd>Space</kbd>+드래그 이동 · <kbd>⌘</kbd>+스크롤 확대 · <kbd>⌘</kbd><kbd>Z</kbd> 되돌리기</p>
          </section>
        </main>
      )}
    </div>
  );
}

function Landing({ onPhoto }: { onPhoto(f: File): void }) {
  const [over, setOver] = useState(false);
  return (
    <main className="landing">
      <div className="step-wrap">
        <h1 className="step-title">벽에 걸기 전에,<br />실제 크기로 걸어보세요.</h1>
        <p className="step-desc">벽 사진과 크기를 아는 물체 하나면 충분해요.</p>
        <label
          className={`dropzone ${over ? 'dropzone-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onPhoto(f); }}
        >
          <div className="dropzone-text">벽 사진을 끌어다 놓거나 <span className="dropzone-link">클릭해서 선택</span></div>
          <div className="dropzone-hint">정면에서 · 1× 렌즈로 · JPG / PNG</div>
          <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); }} />
        </label>
        <div className="flow">
          {[
            ['01', '사진 보정', '회전과 원근으로 벽을 곧게'],
            ['02', '기준 지정', '액자·타일·A4 등 크기를 아는 물체'],
            ['03', '액자 배치', 'cm 단위로 배치하고 간격 확인'],
          ].map(([n, t, d]) => (
            <div key={t} className="flow-item">
              <span className="nav-num">{n}</span>
              <div><b>{t}</b><small>{d}</small></div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
