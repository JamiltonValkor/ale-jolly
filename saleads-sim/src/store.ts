import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DEMO_BUSINESS, DEMO_OFFERINGS} from './demo-data';

/**
 * Estado del imitador. Vive en memoria y se guarda en `<data>/state.json`
 * tras cada cambio, para que reiniciar el contenedor no le quite a Hermes su
 * sesión offline ni al agente sus apuestas y landings.
 */

export interface Business {
  id: string;
  owner: string;
  name: string;
  offering_type: string;
  website_url: string | null;
  country: string;
  currency: string;
  whatsapp_number: string | null;
  profile: Record<string, unknown>;
  created_at: string;
}

export interface Offering {
  id: string;
  business_id: string;
  type: 'product' | 'service';
  name: string;
  description: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
  created_at: string;
}

export interface StrategyVersion {
  version_id: string;
  revision: number;
  status: 'generated' | 'approved' | 'superseded';
  source_version_id: string | null;
  created_at: string;
}

export interface Strategy {
  id: string;
  business_id: string;
  owner: string;
  offering: {type: 'product' | 'service'; id: string};
  destination: 'messages' | 'web';
  locale: string;
  monthly_budget: number;
  currency: string;
  versions: StrategyVersion[];
  plan_id: string | null;
  created_at: string;
}

export interface PlanCampaign {
  item_id: string;
  name: string;
  status: string;
  role: string;
  hypothesis_id: string;
  hypothesis_summary: string;
  monthly_investment: number;
  daily_budget: number;
}

export interface Plan {
  id: string;
  business_id: string;
  owner: string;
  strategy_id: string;
  version_id: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
  replaced_by_plan_id: string | null;
  monthly_budget: number;
  currency: string;
  language: string;
  locations: Array<{key: string; name: string; type: string; country_code?: string}>;
  campaigns: PlanCampaign[];
  created_at: string;
  updated_at: string;
}

export interface AgentBet {
  bet_id: string;
  bet_key: string;
  label: string;
  business_id: string;
  offering_id: string | null;
  state: 'proposed' | 'active' | 'paused' | 'retired';
  state_decided_by: string;
  state_reason: string | null;
  state_at: string;
  communication_strategy_id: string;
  communication_strategy_version_id: string;
  round_number: number;
  message_variant_ids: string[];
  campaign_intent_id: string;
  bet: Record<string, unknown>;
  brain_bet_ref: string | null;
  campaign_refs: string[];
}

export interface AgentRound {
  version_id: string;
  strategy_id: string;
  business_id: string;
  round_number: number;
  bet_ids: string[];
  warnings: unknown[];
  created_at: string;
}

export interface LandingVersion {
  n: number;
  files: Record<string, string>;
  artifactDigest: string;
  createdBy: 'agent' | 'user';
  createdAt: string;
  review: unknown | null;
  artifacts: unknown | null;
  requestId: string;
}

export interface Landing {
  id: string;
  business_id: string;
  owner: string;
  origin: 'hermes' | 'web';
  name: string;
  format: string;
  closing: {type: string; whatsappNumber?: string; agendaUrl?: string};
  context: Record<string, unknown>;
  confirmed_testimonial_ids: string[];
  lineage: Record<string, unknown>;
  status: 'draft' | 'published' | 'unpublished';
  latestN: number | null;
  publishedN: number | null;
  versions: LandingVersion[];
  feedback: Array<{at: string; text: string}>;
  created_at: string;
  updated_at: string;
}

export interface DestinationBinding {
  binding: Record<string, unknown>;
  bet_id: string;
  business_id: string;
}

export interface Operation {
  id: string;
  owner: string;
  tool: string;
  key: string;
  args_hash: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  ready_at: number;
  poll_after_s: number;
  created_at: string;
}

export interface Account {
  user_id: string;
  selected_business_id: string | null;
  language_code: string;
  language_updated_at: string;
  agent_cap: number | null;
}

export interface SimState {
  accounts: Record<string, Account>;
  businesses: Record<string, Business>;
  offerings: Record<string, Offering>;
  strategies: Record<string, Strategy>;
  plans: Record<string, Plan>;
  bets: Record<string, AgentBet>;
  rounds: Record<string, AgentRound>;
  landings: Record<string, Landing>;
  destinations: Record<string, DestinationBinding>;
  operations: Record<string, Operation>;
  /** Respuestas guardadas de escrituras idempotentes: `${user}|${tool}|${client_request_id}`. */
  idempotent: Record<string, {args_hash: string; result: Record<string, unknown>}>;
  /** Sesiones offline revocadas (`sid`) y refresh tokens revocados (`jti`). */
  revokedSessions: Record<string, string>;
  revokedTokens: Record<string, string>;
}

const emptyState = (): SimState => ({
  accounts: {}, businesses: {}, offerings: {}, strategies: {}, plans: {}, bets: {}, rounds: {}, landings: {},
  destinations: {}, operations: {}, idempotent: {}, revokedSessions: {}, revokedTokens: {},
});

export class Store {
  state: SimState;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dataDir: string | null, private readonly demoUserId: string) {
    this.state = emptyState();
    const path = this.path();
    if (path && existsSync(path)) this.state = {...emptyState(), ...JSON.parse(readFileSync(path, 'utf8'))};
    this.seed();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'state.json') : null;
  }

  /** Masquebella (demo) y su catálogo, para el usuario demo del contrato. Idempotente. */
  private seed(): void {
    const now = new Date().toISOString();
    const owner = this.demoUserId;
    if (!this.state.businesses[DEMO_BUSINESS.id]) {
      this.state.businesses[DEMO_BUSINESS.id] = {
        id: DEMO_BUSINESS.id, owner, name: DEMO_BUSINESS.name, offering_type: DEMO_BUSINESS.offering_type,
        website_url: DEMO_BUSINESS.website_url, country: DEMO_BUSINESS.country, currency: DEMO_BUSINESS.currency,
        whatsapp_number: DEMO_BUSINESS.whatsapp_number, profile: DEMO_BUSINESS.profile, created_at: now,
      };
      for (const offering of DEMO_OFFERINGS) {
        this.state.offerings[offering.id] = {...offering, business_id: DEMO_BUSINESS.id, created_at: now};
      }
    }
    this.account(owner).selected_business_id ??= DEMO_BUSINESS.id;
  }

  account(userId: string): Account {
    this.state.accounts[userId] ??= {
      user_id: userId, selected_business_id: null, language_code: 'es', language_updated_at: new Date().toISOString(), agent_cap: 2000,
    };
    return this.state.accounts[userId];
  }

  businessesOf(userId: string): Business[] {
    return Object.values(this.state.businesses).filter((b) => b.owner === userId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  ownedBusiness(userId: string, businessId: unknown): Business | null {
    if (typeof businessId !== 'string') return null;
    const business = this.state.businesses[businessId.toLowerCase()];
    return business && business.owner === userId ? business : null;
  }

  offeringsOf(businessId: string): Offering[] {
    return Object.values(this.state.offerings).filter((o) => o.business_id === businessId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /** Guarda el estado en disco poco después del último cambio (escritura atómica). */
  save(): void {
    const path = this.path();
    if (!path || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 100);
    this.timer.unref?.();
  }

  flush(): void {
    const path = this.path();
    if (!path) return;
    mkdirSync(this.dataDir!, {recursive: true});
    writeFileSync(`${path}.tmp`, JSON.stringify(this.state));
    renameSync(`${path}.tmp`, path);
  }
}
