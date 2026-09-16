import { useMemo } from 'react';
import type { Agent } from '../shared/types';
import './TokenUsageCharts.css';

const compact = (n:number) => Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(n);
export function TokenUsageCharts({agents}:{agents:Agent[]}) {
  const data = useMemo(() => {
    const bins = new Map<number,{input:number;output:number}>();
    for (const agent of agents) for (const point of agent.tokenTimeline ?? []) {
      if (!Number.isFinite(point.timestamp)) continue;
      const minute = Math.floor(point.timestamp / 60000) * 60000;
      const bin = bins.get(minute) ?? {input:0,output:0};
      bin.input += point.inputTokens; bin.output += point.outputTokens; bins.set(minute,bin);
    }
    const times = [...bins.keys()].sort((a,b)=>a-b);
    if (!times.length) return null;
    const start = times[0], end = times.at(-1)!;
    const minutes = (end-start)/60000+1;
    // Bucket wide histories to at most 120 points. Rate retains tokens/minute units.
    const step = Math.max(1,Math.ceil(minutes/120));
    const grouped = Array.from({length:Math.ceil(minutes/step)},(_,index)=>({timestamp:start+index*step*60000,input:0,output:0,cumulative:0}));
    let cumulative = 0, peak = 0;
    for (const [time, bin] of bins) {
      peak = Math.max(peak,bin.input+bin.output);
      const point=grouped[Math.floor((time-start)/60000/step)];
      point.input+=bin.input; point.output+=bin.output;
    }
    const points=grouped.map((point,index)=>{
      cumulative+=point.input+point.output;
      const width=Math.min(step,minutes-index*step);
      return {...point,input:point.input/width,output:point.output/width,cumulative};
    });
    return {points,minutes,step,total:cumulative,peak,start,end};
  },[agents]);
  if (!data) return <p className="token-charts__empty">Usage charts appear when the trace contains timestamped token updates.</p>;
  const maxRate=Math.max(1,...data.points.map(p=>p.input+p.output));
  const maxTotal=Math.max(1,data.total);
  const x=(i:number)=>32+i*520/Math.max(1,data.points.length-1);
  const line=(get:(p:{timestamp:number;input:number;output:number;cumulative:number})=>number,max:number)=>data.points.map((p,i)=>`${i?'L':'M'}${x(i)},${116-get(p)/max*100}`).join(' ');
  const range=(time:number)=>new Date(time).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  return <section className="token-charts" aria-label="Token usage charts">
    <div className="token-charts__stats"><span>Average <strong>{compact(data.total/data.minutes)}/min</strong></span><span>Peak minute <strong>{compact(data.peak)}</strong></span><span>Recorded <strong>{compact(data.total)} tokens</strong></span></div>
    <div className="token-charts__grid">
      <figure><figcaption>Usage rate <small>tokens/min · {data.step>1?`${data.step}-minute averages`:'1-minute buckets'}</small></figcaption>
        <svg viewBox="0 0 580 140" role="img" aria-label={`Token rate, peak ${data.peak.toLocaleString()} tokens in one minute`}>
          <path className="token-chart__axis" d="M32 16V116H552"/><text x="32" y="12">{compact(maxRate)}</text>
          <path className="token-chart__input" d={line(p=>p.input,maxRate)}/><path className="token-chart__output" d={line(p=>p.output,maxRate)}/>
          {data.points.map((p,i)=><circle key={p.timestamp} className="token-chart__point" cx={x(i)} cy={116-(p.input+p.output)/maxRate*100} r="2"><title>{range(p.timestamp)} · IN {Math.round(p.input).toLocaleString()}/min · OUT {Math.round(p.output).toLocaleString()}/min</title></circle>)}
        </svg><div className="token-charts__legend"><span>Input</span><span>Output</span><span>Total dots</span></div>
      </figure>
      <figure><figcaption>Cumulative usage <small>recorded interval</small></figcaption>
        <svg viewBox="0 0 580 140" role="img" aria-label={`Cumulative recorded usage ${data.total.toLocaleString()} tokens`}>
          <path className="token-chart__axis" d="M32 16V116H552"/><text x="32" y="12">{compact(maxTotal)}</text>
          <path className="token-chart__input" d={line(p=>p.cumulative,maxTotal)}/>
          {data.points.map((p,i)=><circle key={p.timestamp} className="token-chart__point" cx={x(i)} cy={116-p.cumulative/maxTotal*100} r="2"><title>{range(p.timestamp)} · {p.cumulative.toLocaleString()} tokens</title></circle>)}
        </svg>
      </figure>
    </div>
    <p className="token-charts__caption">{range(data.start)} – {range(data.end)}. Based on recorded token updates, including cached input. Missing history and untimed usage are excluded; charts may cover less than the run total.</p>
  </section>;
}
