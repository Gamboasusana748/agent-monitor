import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import './RollingNumber.css';

const DECIMAL = (1.5).toLocaleString().charAt(1);

/** Maps each character to its place relative to the decimal separator (or the end when there is none). */
function places(text: string) {
  const point = text.indexOf(DECIMAL);
  const anchor = point === -1 ? text.length : point;
  return [...text].map((char, index) => ({ char, place: anchor - index }));
}

/** One accessible number; changed digits spin a reel on real counter updates. */
export function RollingNumber({ value }: { value: number }) {
  return <RollingText text={Math.max(0, Math.round(value)).toLocaleString()} />;
}

/** Formatted numeric text (e.g. "$1.2345"); digits aligned by decimal place spin when they change. */
export function RollingText({ text }: { text: string }) {
  const previous = useRef(text);
  const old = useMemo(() => new Map(places(previous.current).map(({ char, place }) => [place, char])), [text]);
  useEffect(() => { previous.current = text; }, [text]);
  return <span className="rolling-number" aria-label={text}>
    <span aria-hidden="true">{places(text).map(({ char, place }) => {
      const from = old.get(place);
      const changed = /\d/.test(char) && /\d/.test(from || '') && from !== char;
      const steps = changed ? 10 + (Number(char) - Number(from) + 10) % 10 : 0;
      const reel = Array.from({length:steps+1},(_,step)=>(Number(from)+step)%10);
      const style = {'--reel-end':`${-steps*1.2}em`,'--reel-delay':`${Math.min(6,Math.max(0,place-1))*25}ms`} as CSSProperties;
      return <span className="rolling-number__place" key={place}>{changed
        ? <span className="rolling-number__reel" style={style} key={`${from}-${char}`}>{reel.map((digit,i)=><span key={i}>{digit}</span>)}</span>
        : <span>{char}</span>}</span>;
    })}</span>
  </span>;
}
