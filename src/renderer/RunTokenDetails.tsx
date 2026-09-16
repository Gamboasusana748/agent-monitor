import { useEffect, useId, useRef } from 'react';
import type { Agent } from '../shared/types';
import { estimateAgentCost, PRICING_VERIFIED_AT } from '../shared/pricing';
import { RollingNumber } from './RollingNumber';
import { TokenUsageCharts } from './TokenUsageCharts';

const exact = (value: number) => value.toLocaleString();

function usd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Unknown';
  if (value !== 0 && Math.abs(value) < 0.0001) return '<$0.0001';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

type AgentCost = ReturnType<typeof estimateAgentCost>;

function costLabel(cost: AgentCost) {
  if (cost.complete && cost.usd !== null) return usd(cost.usd);
  return cost.knownUsd > 0 ? usd(cost.knownUsd) : 'Unknown';
}

function costNote(cost: AgentCost) {
  if (cost.notes.length) return cost.notes.join(' ');
  return cost.complete
    ? `Rates verified ${PRICING_VERIFIED_AT}.`
    : 'Known subtotal only; some model rates or cache token metadata are unavailable.';
}

export function RunTokenDetails({ agents }: { agents: Agent[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const titleId = useId();
  const totals = agents.reduce((sum, agent) => ({
    input: sum.input + agent.stats.inputTokens,
    output: sum.output + agent.stats.outputTokens,
  }), { input: 0, output: 0 });
  const rows = [...agents].sort((a, b) =>
    Number(b.type === 'main') - Number(a.type === 'main')
    || (b.stats.inputTokens + b.stats.outputTokens) - (a.stats.inputTokens + a.stats.outputTokens)
    || a.id.localeCompare(b.id));
  const costs = agents.map((agent) => ({ agent, cost: estimateAgentCost(agent) }));
  const costByAgentId = new Map(costs.map(({ agent, cost }) => [agent.id, cost]));
  const totalCost = costs.reduce((sum, { cost }) => ({
    knownUsd: sum.knownUsd + cost.knownUsd,
    unpricedTokens: sum.unpricedTokens + cost.unpricedTokens,
    complete: sum.complete && cost.complete && cost.usd !== null,
  }), { knownUsd: 0, unpricedTokens: 0, complete: costs.length > 0 });
  const totalCostLabel = totalCost.complete
    ? usd(totalCost.knownUsd)
    : totalCost.knownUsd > 0
      ? usd(totalCost.knownUsd)
      : 'Unknown';
  const totalCostNote = totalCost.complete
    ? `Rates verified ${PRICING_VERIFIED_AT}.`
    : totalCost.knownUsd > 0
      ? `Known subtotal from priced usage. ${totalCost.unpricedTokens.toLocaleString()} tokens have no verified rate or complete cache metadata.`
      : `No priced usage is available. ${totalCost.unpricedTokens.toLocaleString()} tokens have no verified rate or complete cache metadata.`;

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current?.open && event.target instanceof Node && !ref.current.contains(event.target)) {
        ref.current.open = false;
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  function close() {
    if (!ref.current) return;
    ref.current.open = false;
    ref.current.querySelector('summary')?.focus();
  }

  return (
    <details className="run-token-details" ref={ref} onKeyDown={event => {
      if (event.key === 'Escape' && ref.current?.open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <summary className="run-token-totals" aria-label={`Run token totals: ${exact(totals.input)} input, ${exact(totals.output)} output, ${totalCostLabel} API token estimate. Show per-agent breakdown`}>
        <span className="run-token-totals__label">Run tokens</span>
        <span className="run-token-totals__value"><span>IN</span><strong><RollingNumber value={totals.input} /></strong></span>
        <span className="run-token-totals__value"><span>OUT</span><strong><RollingNumber value={totals.output} /></strong></span>
        <span className="run-token-totals__value run-token-totals__value--usd" title={`API token estimate (USD). ${totalCostNote}`}><span>USD</span><strong>{totalCostLabel}</strong></span>
        <span className="run-token-totals__details">Details</span>
      </summary>
      <section className="token-breakdown" aria-labelledby={titleId}>
        <header><div><h2 id={titleId}>Token breakdown</h2><p>Main agent and all subagents · {agents.length} agents · <span title={`Rates verified ${PRICING_VERIFIED_AT}; current rates, standard tier when unspecified; not a subscription bill.`}>API token estimate (USD)</span></p><p className="token-breakdown__pricing-note">Rates verified {PRICING_VERIFIED_AT}; current rates, standard tier when unspecified; not a subscription bill.</p></div><button type="button" onClick={close}>Close</button></header>
        <div className="token-breakdown__totals" aria-label="Aggregated run usage">
          <div><span>Input tokens</span><strong><RollingNumber value={totals.input} /></strong></div>
          <div><span>Output tokens</span><strong><RollingNumber value={totals.output} /></strong></div>
          <div><span>Total tokens</span><strong><RollingNumber value={totals.input + totals.output} /></strong></div>
          <div title={totalCostNote}><span>Estimated USD</span><strong>{totalCostLabel}</strong></div>
        </div>
        {!totalCost.complete && <p className="token-breakdown__coverage">Estimate excludes {exact(totalCost.unpricedTokens)} tokens with unknown pricing or incomplete usage metadata.</p>}
        <div className="token-breakdown__body">
        <div className="token-breakdown__scroll">
          <table>
            <thead><tr><th scope="col">Agent</th><th scope="col">IN</th><th scope="col">OUT</th><th scope="col" title={`API token estimate (USD). ${totalCostNote}`}>USD</th></tr></thead>
            <tbody>{rows.map(agent => <tr key={agent.id}>
              <th scope="row" title={agent.id}><strong>{agent.nickname || agent.role || (agent.type === 'main' ? 'Main agent' : `Subagent · ${agent.id.slice(-8)}`)}</strong><span>{agent.type === 'main' ? 'Main' : agent.role || 'Subagent'} · {agent.model || 'Unknown model'}</span></th>
              <td><RollingNumber value={agent.stats.inputTokens} /></td><td><RollingNumber value={agent.stats.outputTokens} /></td><td className="token-breakdown__cost" title={costNote(costByAgentId.get(agent.id) as AgentCost)}>{costLabel(costByAgentId.get(agent.id) as AgentCost)}</td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">Run total</th><td><RollingNumber value={totals.input} /></td><td><RollingNumber value={totals.output} /></td><td className="token-breakdown__cost" title={totalCostNote}>{totalCostLabel}</td></tr></tfoot>
          </table>
        </div>
        <div className="token-breakdown__charts">
          <TokenUsageCharts agents={agents} />
        </div>
        </div>
      </section>
    </details>
  );
}
