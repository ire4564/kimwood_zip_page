import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isConvexQuad } from '../lib/homography';
import { refReady, type RefFrame, type Solution } from '../lib/calibrate';
import { fileToArtDataURL } from '../lib/storage';
import { noAdjust, type Adjust } from '../lib/correction';
import type { Calibration, Frame } from '../types';

/** cm(내부 단위) → mm 표시 문자열 */
const mm = (cm: number) => { const v = Math.round(cm * 100) / 10; return Number.isInteger(v) ? String(v) : v.toFixed(1); };

export const SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'A4', w: 21, h: 29.7 },
  { label: 'A3', w: 29.7, h: 42 },
  { label: 'A2', w: 42, h: 59.4 },
  { label: '4×6"', w: 10.2, h: 15.2 },
  { label: '8×10"', w: 20.3, h: 25.4 },
  { label: '11×14"', w: 27.9, h: 35.6 },
  { label: '300×400', w: 30, h: 40 },
  { label: '400×500', w: 40, h: 50 },
  { label: '500×700', w: 50, h: 70 },
  { label: '600×900', w: 60, h: 90 },
];

// 기준으로 쓸 수 있는 물체 (규격이 정해진 것 위주)
const REF_GROUPS: { id: string; label: string; items: { label: string; name: string; w: number; h: number }[] }[] = [
  { id: 'paper', label: '종이', items: [
    { label: 'A4', name: 'A4 용지', w: 21, h: 29.7 },
    { label: 'A3', name: 'A3 용지', w: 29.7, h: 42 },
    { label: 'A5', name: 'A5 용지', w: 14.8, h: 21 },
    { label: 'B5', name: 'B5 용지', w: 18.2, h: 25.7 },
  ] },
  { id: 'tile', label: '타일', items: [
    { label: '300×300', name: '타일 300×300', w: 30, h: 30 },
    { label: '300×600', name: '타일 300×600', w: 30, h: 60 },
    { label: '600×600', name: '타일 600×600', w: 60, h: 60 },
    { label: '600×1200', name: '타일 600×1200', w: 60, h: 120 },
  ] },
  { id: 'card', label: '카드·엽서', items: [
    { label: '신용카드', name: '신용카드', w: 8.56, h: 5.4 },
    { label: '엽서', name: '엽서', w: 10, h: 15 },
  ] },
  { id: 'frame', label: '액자', items: SIZE_PRESETS.map((p) => ({ label: p.label, name: `액자 ${p.label}`, w: p.w, h: p.h })) },
];

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RefPresets({ onPick }: { onPick(w: number, h: number, name: string): void }) {
  const [g, setG] = useState('paper');
  const group = REF_GROUPS.find((x) => x.id === g)!;
  return (
    <>
      <Segmented value={g} options={REF_GROUPS} onChange={setG} />
      <div className="chips">
        {group.items.map((it) => (
          <button key={it.label} onClick={() => onPick(it.w, it.h, it.name)}>{it.label}</button>
        ))}
      </div>
    </>
  );
}

// ───────────────────────── 공통 UI ─────────────────────────
function Head({ step, title, desc }: { step: number; title: string; desc?: ReactNode }) {
  return (
    <div className="insp-head">
      <div className="insp-title-row">
        <span className="insp-step">{String(step).padStart(2, '0')}</span>
        <h2 className="insp-title">{title}</h2>
      </div>
      {desc && <p className="insp-desc">{desc}</p>}
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-top">
        <h3>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * 숫자 입력칸: 입력 중에는 사용자가 친 글자를 그대로 보여준다.
 * - 다 지우면 빈 칸(흐린 0 표시)이고 값은 0(또는 null)으로 적용
 * - 앞자리 0은 자동으로 지움 (0 → 10 입력 시 "010"이 되지 않게)
 */
function NumInput({
  value, onChange, empty = null, step, min, max,
}: {
  value: number | null; onChange(v: number | null): void; empty?: number | null;
  step?: number; min?: number; max?: number;
}) {
  const [text, setText] = useState<string | null>(null); // 입력 중일 때만 사용
  const shown = text ?? (value == null || value === 0 ? '' : String(value));
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      placeholder="0"
      value={shown}
      onFocus={() => setText(value == null || value === 0 ? '' : String(value))}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const t = e.target.value.replace(/^(-?)0+(?=\d)/, '$1');
        setText(t);
        const v = parseFloat(t);
        onChange(t === '' || Number.isNaN(v) ? empty : v);
      }}
    />
  );
}

function Num({
  label, value, onChange, step = 0.1, min, suffix = 'mm',
}: {
  label: string; value: number | null; onChange(v: number | null): void; step?: number; min?: number; suffix?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="field-box">
        <NumInput value={value} step={step} min={min} onChange={onChange} />
        <em>{suffix}</em>
      </div>
    </label>
  );
}

/** 내부는 cm, 화면 입력·표시는 mm */
function Mm({ label, cm, onChange, min }: { label: string; cm: number | null; onChange(cm: number | null): void; min?: number }) {
  return (
    <Num label={label} suffix="mm" step={1} min={min}
      value={cm == null ? null : Math.round(cm * 100) / 10}
      onChange={(v) => onChange(v == null ? null : v / 10)} />
  );
}

function Chips({ onPick }: { onPick(w: number, h: number): void }) {
  return (
    <div className="chips">
      {SIZE_PRESETS.map((s) => (
        <button key={s.label} onClick={() => onPick(s.w, s.h)}>{s.label}</button>
      ))}
    </div>
  );
}

function Stat({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="stat">
      {rows.map(([k, v]) => (
        <div key={k}><span>{k}</span><b>{v}</b></div>
      ))}
    </div>
  );
}

// ───────────────────────── 0. 사진 보정 ─────────────────────────
function Slider({
  label, value, min, max, onChange,
}: { label: string; value: number; min: number; max: number; onChange(v: number): void }) {
  return (
    <div className="slider">
      <div className="slider-top">
        <b>{label}</b>
        <div className="slider-val">
          <NumInput value={value} empty={0} step={0.1} min={min} max={max}
            onChange={(v) => onChange(Math.max(min, Math.min(max, v ?? 0)))} />
          <em>°</em>
          <button className="icon-btn" title="0으로" disabled={!value} onClick={() => onChange(0)}>↺</button>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={value}
        onDoubleClick={() => onChange(0)}
        onChange={(e) => onChange(+e.target.value)}
        style={{ '--p': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
      />
    </div>
  );
}

export function StraightenPanel({
  adjust, setAdjust, onNext, onAuto,
}: {
  adjust: Adjust; setAdjust(a: Adjust): void; onNext(): void;
  /** 자동 보정 실행. 실패하면 안내 문구를 돌려준다 */
  onAuto(mode: 'vertical' | 'full'): Promise<string | null>;
}) {
  const set = (k: keyof Adjust) => (v: number) => setAdjust({ ...adjust, [k]: Math.round(v * 10) / 10 });
  const [running, setRunning] = useState<'vertical' | 'full' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (mode: 'vertical' | 'full') => {
    setRunning(mode);
    setMsg(null);
    setMsg(await onAuto(mode));
    setRunning(null);
  };
  return (
    <>
      <Head step={1} title="사진 보정" />
      <Section title="자동 보정">
        <div className="auto-row">
          <button className="btn-ghost" disabled={!!running} onClick={() => run('vertical')}>
            {running === 'vertical' ? <span className="spinner" /> : null}수직 맞추기
          </button>
          <button className="btn-ghost" disabled={!!running} onClick={() => run('full')}>
            {running === 'full' ? <span className="spinner" /> : null}수직·수평 맞추기
          </button>
        </div>
        {msg && <div className="warn">{msg}</div>}
      </Section>
      <Section title="원근 · 회전" right={
        <button className="text-btn" onClick={() => setAdjust(noAdjust())}>모두 초기화</button>
      }>
        <Slider label="회전" value={adjust.rotate} min={-15} max={15} onChange={set('rotate')} />
        <Slider label="수직 원근" value={adjust.vertical} min={-30} max={30} onChange={set('vertical')} />
        <Slider label="수평 원근" value={adjust.horizontal} min={-30} max={30} onChange={set('horizontal')} />
      </Section>
      <div className="foot-actions">
        <button className="btn-primary" onClick={onNext}>다음 · 기준 설정 →</button>
      </div>
    </>
  );
}

// ───────────────────────── 1. 기준 설정 ─────────────────────────
const sign = (cm: number) => (cm >= 0 ? '+' : '−') + mm(Math.abs(cm));

function quality(sol: Solution | null, used: number) {
  if (!sol) return null;
  const bad = sol.diags.some((d) => d.rmsPx > 3);
  if (bad) return { tone: 'warn', label: '확인 필요', text: '기준끼리 맞지 않아요' };
  if (used >= 3) return { tone: 'good', label: '매우 높음', text: '' };
  if (used === 2) return { tone: 'good', label: '높음', text: '' };
  return { tone: 'mid', label: '보통', text: '멀리 떨어진 기준을 추가하면 더 정확해져요' };
}

export function CalibratePanel({
  cal, sol, activeId, setActive, updateRef, addRef, removeRef, onDone,
}: {
  cal: Calibration; sol: Solution | null;
  activeId: string | null; setActive(id: string): void;
  updateRef(id: string, p: Partial<RefFrame>): void; addRef(): void; removeRef(id: string): void; onDone(): void;
}) {
  const used = cal.refs.filter(refReady).length;
  const q = quality(sol, used);
  const multi = (sol?.diags.length ?? 0) >= 2;

  return (
    <>
      <Head step={2} title="기준 지정" desc="크기를 아는 물체를 사진에서 드래그하세요" />

      {q && sol && (
        <div className={`quality ${q.tone}`}>
          <div className="quality-top">
            <span>정확도</span>
            <b>{q.label}</b>
          </div>
          {q.text && <p>{q.text}</p>}
          <div className="quality-stats">
            <div><small>기준</small><b>{used}개</b></div>
            <div><small>평균 오차</small><b>{multi ? `${sol.rmsPx.toFixed(1)} px` : '—'}</b></div>
          </div>
        </div>
      )}

      <div className="ref-list">
        {cal.refs.map((r, i) => {
          const open = r.id === activeId;
          const d = sol?.diags.find((x) => x.id === r.id);
          const ready = refReady(r);
          const bad = multi && d && d.rmsPx > 3;
          const status = !r.corners ? '영역 지정 필요' : !(r.widthCm > 0 && r.heightCm > 0) ? '크기 입력 필요'
            : !ready ? '모서리 순서 확인' : bad ? '불일치' : multi && d ? `오차 ${d.rmsPx.toFixed(1)}px` : '준비됨';
          return (
            <section key={r.id} className={`ref-card ${open ? 'open' : ''} ${bad ? 'bad' : ''}`}>
              <button className="ref-head" onClick={() => setActive(r.id)}>
                <span className="ref-num">{i + 1}</span>
                <span className="ref-name">{r.name}{i === 0 && <em className="tag">원점</em>}</span>
                <span className={`ref-status ${ready && !bad ? 'ok' : bad ? 'bad' : ''}`}>{status}</span>
              </button>
              {open && (
                <div className="ref-body">
                  {!r.corners && <p className="sub">액자, 콘센트, 타일, 붙여둔 A4처럼 크기를 잴 수 있는 사각형이면 돼요</p>}
                  <input className="text-input" value={r.name} onChange={(e) => updateRef(r.id, { name: e.target.value })} />
                  <div className="row2">
                    <Mm label="실제 가로" cm={r.widthCm || null} min={0} onChange={(v) => updateRef(r.id, { widthCm: v ?? 0 })} />
                    <Mm label="실제 세로" cm={r.heightCm || null} min={0} onChange={(v) => updateRef(r.id, { heightCm: v ?? 0 })} />
                  </div>
                  <RefPresets onPick={(w, h, name) => updateRef(r.id, { widthCm: w, heightCm: h, ...(/^기준 \d+$/.test(r.name) ? { name } : {}) })} />
                  {ready && Math.max(r.widthCm, r.heightCm) < 15 && <div className="warn">작은 물체는 오차가 커요. 더 큰 물체를 함께 지정하세요</div>}
                  {r.corners && !isConvexQuad(r.corners) && <div className="warn">모서리 순서가 꼬였어요</div>}
                  {multi && d && (
                    <Stat rows={[
                      ['계산된 크기', `${mm(d.measuredW)} × ${mm(d.measuredH)} mm`],
                      ['차이', `${sign(d.measuredW - r.widthCm)} / ${sign(d.measuredH - r.heightCm)} mm`],
                    ]} />
                  )}
                  {bad && (
                    <div className="warn">크기·모서리를 확인하거나, 벽에 붙어 있는 물체인지 확인하세요</div>
                  )}
                  <div className="btn-grid">
                    {r.corners && <button className="btn-ghost sm" onClick={() => updateRef(r.id, { corners: null })}>영역 다시 지정</button>}
                    {cal.refs.length > 1 && <button className="btn-danger sm" onClick={() => removeRef(r.id)}>이 기준 삭제</button>}
                  </div>
                </div>
              )}
            </section>
          );
        })}
        <button className="add-ref" onClick={addRef}>
          <b>+ 기준 추가</b>
        </button>
      </div>

      <div className="foot-actions">
        <button className="btn-primary" disabled={!sol} onClick={onDone}>배치 시작 →</button>
      </div>

    </>
  );
}

// ───────────────────────── 2. 배치 ─────────────────────────
export function ArrangePanel({
  frames, selectedId, onAdd, onUpdate, onDelete, onDuplicate, onSelect,
  snap, setSnap, showGrid, setShowGrid, opacity, setOpacity,
}: {
  frames: Frame[]; selectedId: string | null;
  onAdd(w: number, h: number, name: string): void;
  onUpdate(id: string, p: Partial<Frame>): void;
  onDelete(id: string): void;
  onDuplicate(id: string): void;
  onSelect(id: string | null): void;
  snap: boolean; setSnap(v: boolean): void;
  showGrid: boolean; setShowGrid(v: boolean): void;
  opacity: number; setOpacity(v: number): void;
}) {
  const [w, setW] = useState<number | null>(null);
  const [h, setH] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const sel = frames.find((f) => f.id === selectedId) || null;
  const editorRef = useRef<HTMLDivElement>(null);

  const resetForm = () => { setW(null); setH(null); setName(''); };
  const add = () => {
    onAdd(w!, h!, name.trim() || `액자 ${frames.length + 1}`);
    resetForm();
    setAdding(false);
  };

  // 액자를 선택하면 아래 편집 영역으로 스크롤 + 포커스
  // (오른쪽 패널 안에서만 스크롤해서, 모바일에서 사진을 드래그하는 중에 페이지가 튀지 않게)
  useEffect(() => {
    if (!selectedId) return;
    const id = requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      const sc = el.closest('.insp-scroll') as HTMLElement | null;
      if (sc && sc.scrollHeight > sc.clientHeight) {
        const top = sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 32;
        sc.scrollTo({ top, behavior: 'smooth' });
      }
      el.focus({ preventScroll: true });
      el.querySelector('.card')?.animate(
        [{ boxShadow: '0 0 0 3px rgba(0,122,255,.55)' }, { boxShadow: '0 0 0 3px rgba(0,122,255,0)' }],
        { duration: 1100, easing: 'ease-out' },
      );
    });
    return () => cancelAnimationFrame(id);
  }, [selectedId]);

  return (
    <>
      <Head step={3} title="액자 배치" />

      {!adding ? (
        <button className="btn-primary add-open" onClick={() => setAdding(true)}>+ 새 액자 추가</button>
      ) : (
        <Section title="새 액자 추가" right={<button className="text-btn" onClick={() => { resetForm(); setAdding(false); }}>취소</button>}>
          <div className="row2">
            <Mm label="가로" cm={w} min={0} onChange={setW} />
            <Mm label="세로" cm={h} min={0} onChange={setH} />
          </div>
          <Chips onPick={(a, b) => { setW(a); setH(b); }} />
          <div className="add-row">
            <input className="text-input" placeholder="이름 (선택)" value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && w && h) add(); }} />
            <button className="btn-primary sm" disabled={!w || !h} onClick={add}>추가</button>
          </div>
        </Section>
      )}

      <Section title={`내 액자 ${frames.length}개`}>
        <div className="toggles">
          <label className="switch"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /><i />자석 정렬</label>
          <label className="switch"><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /><i />100mm 격자</label>
        </div>
        <label className="opacity">
          <span>액자 투명도</span>
          <input type="range" min={0.3} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)}
            style={{ '--p': `${((opacity - 0.3) / 0.7) * 100}%` } as React.CSSProperties} />
          <em>{Math.round(opacity * 100)}%</em>
        </label>
        {frames.length === 0 ? (
          <p className="sub">아직 추가한 액자가 없어요.</p>
        ) : (
          <div className="list">
            {frames.map((f) => (
              <button key={f.id} className={`list-row ${f.id === selectedId ? 'on' : ''}`} onClick={() => onSelect(f.id)}>
                <i style={{ background: f.color }} />
                <span>{f.name}</span>
                <em>{mm(f.w)} × {mm(f.h)}</em>
              </button>
            ))}
          </div>
        )}
      </Section>

      {sel && (
        <div ref={editorRef} tabIndex={-1} className="editor-anchor">
        <Section title="선택한 액자" right={<button className="text-btn" onClick={() => onSelect(null)}>닫기</button>}>
          <input className="text-input strong" value={sel.name} onChange={(e) => onUpdate(sel.id, { name: e.target.value })} />
          <div className="sub-label">크기</div>
          <div className="row2">
            <Mm label="가로" cm={sel.w} min={0} onChange={(v) => v && onUpdate(sel.id, { w: v })} />
            <Mm label="세로" cm={sel.h} min={0} onChange={(v) => v && onUpdate(sel.id, { h: v })} />
          </div>
          <div className="rot-row">
            <Num label="회전" suffix="°" value={sel.rot ?? 0} onChange={(v) => onUpdate(sel.id, { rot: Math.max(-180, Math.min(180, v ?? 0)) })} />
            <button className="btn-ghost sm" disabled={!sel.rot} onClick={() => onUpdate(sel.id, { rot: 0 })}>0°</button>
          </div>
          <div className="sub-label">스타일</div>
          <div className="row2">
            <Mm label="프레임 두께" cm={sel.border} min={0} onChange={(v) => onUpdate(sel.id, { border: v ?? 0 })} />
            <label className="field"><span className="field-label">프레임 색</span>
              <input className="color" type="color" value={sel.color} onChange={(e) => onUpdate(sel.id, { color: e.target.value })} />
            </label>
          </div>
          <div className="swatches">
            {['#1f1c1a', '#ffffff', '#8a5a3b', '#c8a26b', '#b8b2a7', '#a07c3a'].map((c) => (
              <button key={c} className={sel.color === c ? 'on' : ''} style={{ background: c }} onClick={() => onUpdate(sel.id, { color: c })} title={c} />
            ))}
          </div>
          <div className="btn-grid">
            <label className="btn-ghost sm file">
              {sel.art ? '그림 바꾸기' : '그림 넣기'}
              <input type="file" accept="image/*" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) onUpdate(sel.id, { art: await fileToArtDataURL(f) });
                e.target.value = '';
              }} />
            </label>
            {sel.art && <button className="btn-ghost sm" onClick={() => onUpdate(sel.id, { art: null })}>그림 빼기</button>}
            <button className="btn-ghost sm" onClick={() => onUpdate(sel.id, { w: sel.h, h: sel.w })}>가로·세로 바꾸기</button>
            <button className="btn-ghost sm" onClick={() => onDuplicate(sel.id)}>복제</button>
            <button className="btn-danger sm" onClick={() => onDelete(sel.id)}>삭제</button>
          </div>
        </Section>
        </div>
      )}
    </>
  );
}
