import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {createAgentApi} from './agent-api';
import {createBearerAuthenticator} from './auth';
import {loadConfig, type SimConfig} from './config';
import {handleGateway} from './gateway';
import {BodyTooLarge, sendJson} from './http-util';
import {RealmKeys} from './keys';
import {handleLandingWeb} from './landing-web';
import {createMcpEndpoint, type CallLogger} from './mcp';
import {Oidc} from './oidc';
import {Store} from './store';
import {buildRegistry} from './tools/registry';

/** Ensambla todas las superficies de saleads-sim sobre un único node:http. */

export interface SimApp {
  server: Server;
  config: SimConfig;
  store: Store;
  oidc: Oidc;
  keys: RealmKeys;
  calls: Array<Parameters<CallLogger>[0]>;
}

export async function createApp(overrides: Partial<SimConfig> = {}, options: {fetch?: typeof fetch; persist?: boolean} = {}): Promise<SimApp> {
  const config = {...loadConfig(), ...overrides};
  const keys = await RealmKeys.load(config.dataDir);
  const store = new Store(options.persist === false ? null : config.dataDir, config.demoUserId);
  const oidc = new Oidc(config, keys, store);
  const deps = {config, store, fetch: options.fetch ?? fetch};
  const registry = buildRegistry(deps);
  const authenticate = createBearerAuthenticator(config, keys);
  const calls: SimApp['calls'] = [];
  const log: CallLogger = (event) => {
    calls.push(event);
    if (calls.length > 500) calls.shift();
    if (event.outcome !== 'ok') console.log(JSON.stringify({msg: 'tool.call', ...event, user: undefined}));
  };
  const mcp = createMcpEndpoint(config, registry, authenticate, log);
  const agentApi = createAgentApi(config, registry, authenticate, log);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://saleads-sim.local');
    const path = url.pathname;
    if (path === '/mcp') return mcp(req, res);
    if (path === '/healthz' || path === '/readyz') return sendJson(res, 200, {status: 'ok', service: 'saleads-sim', simulated: true});
    const agent = /^\/agent\/v1\/commands(?:\/([^/]+))?\/?$/.exec(path);
    if (agent) return agentApi.serve(req, res, url, agent[1] ? decodeURIComponent(agent[1]) : undefined);
    if (path === '/sim/calls') return sendJson(res, 200, {calls});
    if (await oidc.handle(req, res, url)) return;
    if (await handleLandingWeb(config, store, req, res, url)) return;
    if (await handleGateway(config, keys, store, req, res, url)) return;
    if (path === '/' || path === '/sim') {
      return sendJson(res, 200, {
        service: 'saleads-sim', simulated: true, issuer: config.issuer, mcp: config.mcpUrl,
        agent_api: `${config.publicBaseUrl}/agent/v1/commands`, session: '/sim/session', landings: '/sim/landings',
        tools: registry.size, agent_commands: agentApi.enabledCommands().length,
      });
    }
    sendJson(res, 404, {error: 'not_found', simulated: true});
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      if (error instanceof BodyTooLarge) return sendJson(res, 413, {error: 'payload_too_large'});
      console.error(JSON.stringify({msg: 'http.error', error: (error as Error)?.name, message: (error as Error)?.message}));
      sendJson(res, 500, {error: 'internal_error'});
    });
  });
  return {server, config, store, oidc, keys, calls};
}
