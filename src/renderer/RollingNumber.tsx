import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import './RollingNumber.css';

/** One accessible number; changed digits spin a reel on real counter updates. */
export function RollingNumber({ value }: { value: number }) {
  const previous = useRef(value);
  const label = Math.max(0, Math.round(value)).toLocaleString();
  const old = useMemo(() => Math.max(0, Math.round(previous.current)).toLocaleString(), [value]);
  useEffect(() => { previous.current = value; }, [value]);
  return <span className="rolling-number" aria-label={label}>
    <span aria-hidden="true">{[...label].map((char, index) => {
      const place = label.length - index;
      const from = old[old.length - place];
      const changed = /\d/.test(char) && /\d/.test(from || '') && from !== char;
      const steps = changed ? 10 + (Number(char) - Number(from) + 10) % 10 : 0;
      const reel = Array.from({length:steps+1},(_,step)=>(Number(from)+step)%10);
      const style = {'--reel-end':`${-steps*1.2}em`,'--reel-delay':`${Math.min(6,place-1)*25}ms`} as CSSProperties;
      return <span className="rolling-number__place" key={place}>{changed
        ? <span className="rolling-number__reel" style={style} key={`${from}-${char}`}>{reel.map((digit,i)=><span key={i}>{digit}</span>)}</span>
        : <span>{char}</span>}</span>;
    })}</span>
  </span>;
}
