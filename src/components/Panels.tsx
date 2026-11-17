import { useState, type ReactNode } from 'react';
import { apply, dist, isConvexQuad, type Mat3 } from '../lib/homography';
import { refReady, type RefFrame, type Solution } from '../lib/calibrate';
import { fileToArtDataURL } from '../lib/storage';
import { noAdjust, type Adjust } from '../lib/correction';
import type { Calibration, Frame, Measurement } from '../types';

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

export const SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'A4', w: 21, h: 29.7 },
  { label: 'A3', w: 29.7, h: 42 },
  { label: 'A2', w: 42, h: 59.4 },
  { label: '4×6"', w: 10.2, h: 15.2 },
  { label: '8×10"', w: 20.3, h: 25.4 },
  { label: '11×14"', w: 27.9, h: 35.6 },
  { label: '30×40', w: 30, h: 40 },
  { label: '40×50', w: 40, h: 50 },
  { label: '50×70', w: 50, h: 70 },
  { label: '60×90', w: 60, h: 90 },
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
    { label: '30×30', name: '타일 30×30', w: 30, h: 30 },
    { label: '30×60', name: '타일 30×60', w: 30, h: 60 },
    { label: '60×60', name: '타일 60×60', w: 60, h: 60 },
    { label: '60×120', name: '타일 60×120', w: 60, h: 120 },
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

function Num({
  label, value, onChange, step = 0.1, min, suffix = 'cm',
}: {
  label: string; value: number | null; onChange(v: number | null): void; step?: number; min?: number; suffix?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="field-box">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : parseFloat(e.target.value))}
        />
        <em>{suffix}</em>
      </div>
    </label>
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
          <input
            type="number"
            step={0.1}
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(Math.max(min, Math.min(max, parseFloat(e.target.value) || 0)))}
          />
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
  adjust, setAdjust, onNext,
}: { adjust: Adjust; setAdjust(a: Adjust): void; onNext(): void }) {
  const set = (k: keyof Adjust) => (v: number) => setAdjust({ ...adjust, [k]: Math.round(v * 10) / 10 });
  return (
    <>
      <Head step={1} title="사진 보정" />
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
const sign = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);

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
                    <Num label="실제 가로" value={r.widthCm || null} min={0} onChange={(v) => updateRef(r.id, { widthCm: v ?? 0 })} />
                    <Num label="실제 세로" value={r.heightCm || null} min={0} onChange={(v) => updateRef(r.id, { heightCm: v ?? 0 })} />
                  </div>
                  <RefPresets onPick={(w, h, name) => updateRef(r.id, { widthCm: w, heightCm: h, ...(/^기준 \d+$/.test(r.name) ? { name } : {}) })} />
                  {ready && Math.max(r.widthCm, r.heightCm) < 15 && <div className="warn">작은 물체는 오차가 커요. 더 큰 물체를 함께 지정하세요</div>}
                  {r.corners && !isConvexQuad(r.corners) && <div className="warn">모서리 순서가 꼬였어요</div>}
                  {multi && d && (
                    <Stat rows={[
                      ['계산된 크기', `${d.measuredW.toFixed(1)} × ${d.measuredH.toFixed(1)} cm`],
                      ['차이', `${sign(d.measuredW - r.widthCm)} / ${sign(d.measuredH - r.heightCm)} cm`],
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
  const [w, setW] = useState<number | null>(30);
  const [h, setH] = useState<number | null>(40);
  const [name, setName] = useState('');
  const sel = frames.find((f) => f.id === selectedId) || null;

  return (
    <>
      <Head step={3} title="액자 배치" />

      <Section title="새 액자 추가">
        <div className="row2">
          <Num label="가로" value={w} min={0} onChange={setW} />
          <Num label="세로" value={h} min={0} onChange={setH} />
        </div>
        <Chips onPick={(a, b) => { setW(a); setH(b); }} />
        <div className="add-row">
          <input className="text-input" placeholder="이름 (선택)" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn-primary sm"
            disabled={!w || !h}
            onClick={() => { onAdd(w!, h!, name.trim() || `액자 ${frames.length + 1}`); setName(''); }}
          >추가</button>
        </div>
      </Section>

      <Section title={`내 액자 ${frames.length}개`}>
        <div className="toggles">
          <label className="switch"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /><i />자석 정렬</label>
          <label className="switch"><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /><i />10cm 격자</label>
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
                <em>{fmt(f.w)} × {fmt(f.h)}</em>
              </button>
            ))}
          </div>
        )}
      </Section>

      {sel && (
        <Section title="선택한 액자" right={<button className="text-btn" onClick={() => onSelect(null)}>닫기</button>}>
          <input className="text-input strong" value={sel.name} onChange={(e) => onUpdate(sel.id, { name: e.target.value })} />
          <div className="sub-label">크기</div>
          <div className="row2">
            <Num label="가로" value={sel.w} min={0} onChange={(v) => v && onUpdate(sel.id, { w: v })} />
            <Num label="세로" value={sel.h} min={0} onChange={(v) => v && onUpdate(sel.id, { h: v })} />
          </div>
          <div className="rot-row">
            <Num label="회전" suffix="°" value={sel.rot ?? 0} onChange={(v) => onUpdate(sel.id, { rot: Math.max(-180, Math.min(180, v ?? 0)) })} />
            <button className="btn-ghost sm" disabled={!sel.rot} onClick={() => onUpdate(sel.id, { rot: 0 })}>0°</button>
          </div>
          <div className="sub-label">스타일</div>
          <div className="row2">
            <Num label="프레임 두께" value={sel.border} min={0} onChange={(v) => onUpdate(sel.id, { border: v ?? 0 })} />
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
      )}
    </>
  );
}

// ───────────────────────── 3. 측정 ─────────────────────────
export function MeasurePanel({
  list, Hiw, onChange,
}: { list: Measurement[]; Hiw: Mat3 | null; onChange(m: Measurement[]): void }) {
  return (
    <>
      <Head step={4} title="길이 측정" desc="사진 위를 드래그해서 재세요" />
      <Section title={`측정 ${list.length}개`} right={list.length > 0 && <button className="text-btn" onClick={() => onChange([])}>모두 지우기</button>}>
        {Hiw && list.length > 0 ? (
          <div className="list">
            {list.map((m, i) => (
              <div key={m.id} className="list-row">
                <span>측정 {i + 1}</span>
                <em className="big-num">{dist(apply(Hiw, m.a), apply(Hiw, m.b)).toFixed(1)} cm</em>
                <button className="icon-btn" onClick={() => onChange(list.filter((x) => x.id !== m.id))}>✕</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="sub">측정한 길이가 없어요</p>
        )}
      </Section>
    </>
  );
}
