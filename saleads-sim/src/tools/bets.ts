import {randomUUID} from 'node:crypto';
import type {AgentBet} from '../store';
import {
  conflict, guarded, invalid, isUuid, nowIso, ownedBusiness, record, text, toolError,
  type ToolDeps, type ToolHandler,
} from './common';
import {idempotent} from './operations';

/**
 * Apuestas del agente (ADR0021): Strategy guarda el registro tal cual lo
 * decidió el agente, sin LLM ni plan. `bet_id = communication_hypothesis_id`
 * y cada vuelta es una `communication_strategy_version_id` nueva. Formas de
 * sa-strategy-service `agent-authored-version.service.ts`.
 */

const TRANSITIONS: Record<AgentBet['state'], AgentBet['state'][]> = {
  proposed: ['active', 'paused', 'retired'],
  active: ['paused', 'retired'],
  paused: ['active', 'retired'],
  retired: [],
};

export function betHandlers(deps: ToolDeps): Record<string, ToolHandler> {
  const {store} = deps;
  return {
    saleads_agent_register_bets: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const scope = record(args.offering_scope);
      const ids = Array.isArray(scope.ids) ? scope.ids : [];
      for (const id of ids) {
        if (!isUuid(id) || store.state.offerings[id]?.business_id !== business.id) throw invalid('offering_scope.ids', 'Las ofertas del alcance deben ser del negocio.');
      }
      const bets = Array.isArray(args.bets) ? args.bets.map(record) : [];
      const keys = new Set<string>();
      for (const [i, bet] of bets.entries()) {
        if (!text(bet.bet_key) || keys.has(text(bet.bet_key))) throw invalid(`bets/${i}/bet_key`, 'Cada apuesta necesita un bet_key único en la vuelta.');
        keys.add(text(bet.bet_key));
      }
      return idempotent(deps, ctx, 'saleads_agent_register_bets', args, async () => {
        const rounds = Object.values(store.state.rounds).filter((r) => r.business_id === business.id);
        let strategyId: string = randomUUID();
        let round = 1;
        if (args.source_version_id !== undefined) {
          const source = store.state.rounds[String(args.source_version_id).toLowerCase()];
          if (!source || source.business_id !== business.id) throw invalid('source_version_id', 'La versión de origen no es una vuelta de este negocio.');
          strategyId = source.strategy_id;
          round = source.round_number + 1;
        } else if (rounds.length) {
          const last = rounds.sort((a, b) => b.round_number - a.round_number)[0];
          strategyId = last.strategy_id;
          round = last.round_number + 1;
        }
        const versionId = randomUUID();
        const now = nowIso();
        const created = bets.map((bet) => {
          const betId = randomUUID();
          const copies = Array.isArray(bet.copies) ? bet.copies : [];
          const row: AgentBet = {
            bet_id: betId, bet_key: text(bet.bet_key), label: text(bet.label) || text(bet.angle) || text(bet.bet_key),
            business_id: business.id, offering_id: ids.length === 1 ? String(ids[0]) : null, state: 'proposed',
            state_decided_by: 'agent', state_reason: null, state_at: now, communication_strategy_id: strategyId,
            communication_strategy_version_id: versionId, round_number: round,
            message_variant_ids: copies.map(() => randomUUID()), campaign_intent_id: randomUUID(), bet,
            brain_bet_ref: text(bet.brain_bet_ref) || null, campaign_refs: [],
          };
          store.state.bets[betId] = row;
          return row;
        });
        store.state.rounds[versionId] = {
          version_id: versionId, strategy_id: strategyId, business_id: business.id, round_number: round,
          bet_ids: created.map((b) => b.bet_id), warnings: [], created_at: now,
        };
        store.save();
        return {
          communication_strategy_id: strategyId, communication_strategy_version_id: versionId, round_number: round,
          review_hash: null, warnings: [], replayed: false,
          bets: created.map((b) => ({
            bet_key: b.bet_key, bet_id: b.bet_id, communication_hypothesis_id: b.bet_id, message_variant_ids: b.message_variant_ids,
            campaign_intent_id: b.campaign_intent_id, label: b.label, brain_bet_ref: b.brain_bet_ref,
          })),
          agent_action_id: randomUUID(),
        };
      }, (stored) => ({...stored, replayed: true}));
    }),

    saleads_agent_bet_state: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      if (!isUuid(args.bet_id)) throw invalid('bet_id');
      const bet = store.state.bets[String(args.bet_id).toLowerCase()];
      if (!bet || bet.business_id !== business.id) {
        throw toolError('MCP-E-NOT-FOUND', 'La apuesta no existe en este negocio.', 'Usa un bet_id devuelto por saleads_agent_register_bets.');
      }
      return idempotent(deps, ctx, 'saleads_agent_bet_state', args, async () => {
        const next = args.state as AgentBet['state'];
        const previous = bet.state;
        if (previous !== next && !TRANSITIONS[previous].includes(next)) {
          throw conflict(`La apuesta está ${previous} y no puede pasar a ${next}.`, 'Lee el estado actual y decide de nuevo.', {from: previous, to: next});
        }
        bet.state = next;
        bet.state_decided_by = 'agent';
        bet.state_reason = text(args.reason) || null;
        bet.state_at = nowIso();
        if (Array.isArray(args.campaign_refs)) bet.campaign_refs = args.campaign_refs.map(String);
        store.save();
        return {
          bet_id: bet.bet_id, state: bet.state, previous_state: previous, decided_by: 'agent', reason: bet.state_reason,
          state_at: bet.state_at, campaign_refs: bet.campaign_refs, replayed: false, agent_action_id: randomUUID(),
        };
      }, (stored) => ({...stored, replayed: true}));
    }),
  };
}
