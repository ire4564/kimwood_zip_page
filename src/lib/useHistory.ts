import { useEffect, useRef } from 'react';

/**
 * 값 하나의 되돌리기/다시하기 기록.
 * 슬라이더·드래그처럼 연속으로 바뀌는 값은 400ms 동안 멈출 때까지를 한 단계로 묶는다.
 */
export function useHistory<T>(value: T, apply: (v: T) => void, ready: boolean) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const committed = useRef<T | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const skip = useRef(false);
  const cur = useRef(value);
  cur.current = value;

  useEffect(() => {
    if (!ready) return;
    if (skip.current) {
      skip.current = false;
      committed.current = value;
      return;
    }
    if (committed.current === undefined) {
      committed.current = value;
      return;
    }
    if (committed.current === value) return;
    if (timer.current === undefined) {
      past.current.push(committed.current);
      if (past.current.length > 200) past.current.shift();
      future.current = [];
    } else {
      clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      committed.current = cur.current;
    }, 400);
  }, [value, ready]);

  const flush = () => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
      committed.current = cur.current;
    }
  };

  return {
    undo() {
      flush();
      const prev = past.current.pop();
      if (prev === undefined) return false;
      future.current.push(cur.current);
      skip.current = true;
      apply(prev);
      return true;
    },
    redo() {
      flush();
      const next = future.current.pop();
      if (next === undefined) return false;
      past.current.push(cur.current);
      skip.current = true;
      apply(next);
      return true;
    },
    reset() {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
      past.current = [];
      future.current = [];
      committed.current = undefined;
      skip.current = false;
    },
  };
}
