import {type McpCallOutcome, type McpToolClient, withAccountOverviewCache} from '../src/orqa/mcp-client';

const OVERVIEW = 'saleads_get_account_overview';

function fake(outcomes: McpCallOutcome[] = []) {
  const calls: Array<{token: string; name: string}> = [];
  const inner: McpToolClient = {
    call: async (token, name) => {
      calls.push({token, name});
      return outcomes.shift() ?? {ok: true, data: {n: calls.length}};
    },
  };
  return {inner, calls};
}

describe('withAccountOverviewCache', () => {
  it('comparte la vista general por token dentro del plazo y la vuelve a pedir al vencer', async () => {
    let t = 0;
    const {inner, calls} = fake();
    const mcp = withAccountOverviewCache(inner, 15_000, () => t);
    const [a, b] = await Promise.all([mcp.call('tok-1', OVERVIEW, {}, 1000), mcp.call('tok-1', OVERVIEW, {}, 1000)]);
    t = 14_999;
    await mcp.call('tok-1', OVERVIEW, {}, 1000);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
    await mcp.call('tok-2', OVERVIEW, {}, 1000);
    expect(calls).toHaveLength(2);
    t = 15_000;
    await mcp.call('tok-1', OVERVIEW, {}, 1000);
    expect(calls).toHaveLength(3);
  });

  it('no guarda fallos ni toca otras herramientas, y elegir negocio borra la del dueño', async () => {
    const {inner, calls} = fake([{ok: false, code: 'mcp_http_502'}]);
    const mcp = withAccountOverviewCache(inner, 15_000, () => 0);
    expect(await mcp.call('tok', OVERVIEW, {}, 1000)).toEqual({ok: false, code: 'mcp_http_502'});
    await Promise.resolve();
    await mcp.call('tok', OVERVIEW, {}, 1000);
    await mcp.call('tok', OVERVIEW, {}, 1000);
    expect(calls).toHaveLength(2);
    await mcp.call('tok', 'saleads_get_business_bootstrap', {business_id: 'x'}, 1000);
    await mcp.call('tok', 'saleads_get_business_bootstrap', {business_id: 'x'}, 1000);
    expect(calls).toHaveLength(4);
    await mcp.call('tok', 'saleads_select_business', {business_id: 'y'}, 1000);
    await mcp.call('tok', OVERVIEW, {}, 1000);
    expect(calls.map(call => call.name).slice(-2)).toEqual(['saleads_select_business', OVERVIEW]);
  });
});
