import {Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {
  STOCK_SAY_TEXT_MAX, STOCK_TOOLS, StockApproveRequestV1, StockAreaV1, StockAutonomyAreaV1, StockAutonomyLevelRequestV1, StockAutonomyV1, StockIdempotencyKeyV1, StockItemsV1, StockOrdersV1, StockProposalV1, StockProposalsQueryV1,
  StockProposalsV1, StockProposeResponseV1, StockRejectRequestV1, StockStatusV1, StockSummaryV1,
} from '../contracts/stock-v1';
import {invalidRequest, notFound, stockTextTooLong} from '../domain/errors';
import {AssistantFlagGuard} from '../http/assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from '../http/auth.guard';
import {InternalTokenGuard, type InternalRequest} from '../http/internal-token.guard';
import type {StockRuntime} from './module';

export const STOCK_RUNTIME = Symbol('STOCK_RUNTIME');

const Id = z.uuid();
const idOf = (raw: string): string => {
  const parsed = Id.safeParse(raw);
  if (!parsed.success) throw notFound();
  return parsed.data;
};

function revisionOf(raw: string | undefined): number {
  const match = typeof raw === 'string' ? /^"?(\d{1,9})"?$/.exec(raw.trim()) : null;
  if (!match) throw invalidRequest();
  return Number(match[1]);
}

function keyOf(raw: string | undefined): string {
  const parsed = StockIdempotencyKeyV1.safeParse(raw);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

const ByBusiness = () => UseGuards(AuthGuard, AssistantFlagGuard);
const NoStore = () => Header('Cache-Control', 'no-store');

/** Pantalla de Stock. `status` lleva solo AuthGuard: debe responder aunque no haya bandera de asistente. */
@Controller('assistants/me')
export class StockWebController {
  constructor(@Inject(STOCK_RUNTIME) private readonly stock: StockRuntime) {}

  private async business(request: AuthenticatedRequest, raw: string): Promise<string> {
    const businessId = idOf(raw);
    await this.stock.access.assertBusiness(request.principal.userId, businessId);
    return businessId;
  }

  @Get('stock/status')
  @UseGuards(AuthGuard)
  @NoStore()
  async status(@Req() request: AuthenticatedRequest) {
    const businessIds = await this.stock.enabledBusinesses(request.principal.userId);
    return StockStatusV1.parse({enabled: businessIds.length > 0, business_ids: businessIds});
  }

  @Get('businesses/:businessId/stock/summary')
  @ByBusiness()
  @NoStore()
  async summary(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string) {
    return StockSummaryV1.parse(await this.stock.reads.summary(await this.business(request, raw)));
  }

  @Get('businesses/:businessId/stock/items')
  @ByBusiness()
  @NoStore()
  async items(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string) {
    return StockItemsV1.parse(await this.stock.reads.items(await this.business(request, raw)));
  }

  @Get('businesses/:businessId/stock/proposals')
  @ByBusiness()
  @NoStore()
  async proposals(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Query() query: unknown) {
    const businessId = await this.business(request, raw);
    const {status, limit} = StockProposalsQueryV1.parse(query);
    return StockProposalsV1.parse({propuestas: await this.stock.proposals.list(businessId, status, limit, {web: true})});
  }

  @Post('businesses/:businessId/stock/proposals/:proposalId/approve')
  @HttpCode(200)
  @ByBusiness()
  @NoStore()
  async approve(
    @Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('proposalId') proposalId: string, @Body() body: unknown,
    @Headers('if-match') ifMatch?: string, @Headers('idempotency-key') key?: string,
  ) {
    const businessId = await this.business(request, raw);
    const [revision, decisionKey] = [revisionOf(ifMatch), keyOf(key)];
    const input = StockApproveRequestV1.parse(body ?? {});
    return StockProposalV1.parse(await this.stock.proposals.approveWeb(request.principal, businessId, idOf(proposalId), revision, decisionKey, input.causa, input.motivo, input.reparto));
  }

  @Post('businesses/:businessId/stock/proposals/:proposalId/reject')
  @HttpCode(200)
  @ByBusiness()
  @NoStore()
  async reject(
    @Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('proposalId') proposalId: string, @Body() body: unknown,
    @Headers('if-match') ifMatch?: string, @Headers('idempotency-key') key?: string,
  ) {
    const businessId = await this.business(request, raw);
    const [revision, decisionKey] = [revisionOf(ifMatch), keyOf(key)];
    const input = StockRejectRequestV1.parse(body ?? {});
    return StockProposalV1.parse(await this.stock.proposals.reject(request.principal, businessId, idOf(proposalId), revision, decisionKey, input.motivo));
  }

  @Get('businesses/:businessId/stock/orders')
  @ByBusiness()
  @NoStore()
  async orders(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string) {
    return StockOrdersV1.parse(await this.stock.reads.orders(await this.business(request, raw)));
  }

  /** Solo pantalla, sin herramienta MCP: el catálogo sigue en 15, y Stock no puede cancelar lo que el dueño aprobó. */
  @Post('businesses/:businessId/stock/orders/:orderId/cancel')
  @HttpCode(200)
  @ByBusiness()
  @NoStore()
  async cancelOrder(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('orderId') orderId: string) {
    const businessId = await this.business(request, raw);
    await this.stock.negotiation.cancel(request.principal.userId, businessId, idOf(orderId));
    const {pedidos} = await this.stock.reads.orders(businessId);
    return pedidos.find(pedido => pedido.id === orderId);
  }

  @Get('businesses/:businessId/stock/autonomy')
  @ByBusiness()
  @NoStore()
  async autonomy(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string) {
    return StockAutonomyV1.parse(await this.stock.autonomy.read(await this.business(request, raw)));
  }

  /** El dueño baja de nivel (R34), o regresa de 1 a 2. Subir más no existe por esta ruta: se pide con evidencia y se aprueba como propuesta. */
  @Post('businesses/:businessId/stock/autonomy/:area/level')
  @HttpCode(200)
  @ByBusiness()
  @NoStore()
  async level(
    @Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('area') area: string, @Body() body: unknown,
    @Headers('if-match') ifMatch?: string, @Headers('idempotency-key') key?: string,
  ) {
    const businessId = await this.business(request, raw);
    const [revision, decisionKey] = [revisionOf(ifMatch), keyOf(key)];
    const parsedArea = StockAreaV1.safeParse(area);
    if (!parsedArea.success) throw notFound();
    const input = StockAutonomyLevelRequestV1.parse(body);
    return StockAutonomyAreaV1.parse(await this.stock.autonomy.lower(request.principal, businessId, parsedArea.data, revision, decisionKey, input.nivel, input.motivo));
  }
}

/**
 * Rutas que solo llama sa-mcp-server: una por herramienta, lista cerrada de IVB-004. Ninguna aprueba plata: la única
 * escritura de confirmación es `confirm-count`, que solo acepta conteos.
 */
@Controller('internal/stock/businesses/:businessId')
@UseGuards(InternalTokenGuard)
export class StockInternalController {
  constructor(@Inject(STOCK_RUNTIME) private readonly stock: StockRuntime) {}

  private async business(request: InternalRequest, raw: string, header: string | undefined): Promise<string> {
    const businessId = idOf(raw);
    if (header !== businessId) throw notFound();
    await this.stock.access.assertBusiness(request.internalUserId, businessId);
    return businessId;
  }

  @Get('overview')
  @NoStore()
  async overview(@Req() request: InternalRequest, @Param('businessId') raw: string, @Query() query: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const {tarjeta, order_id: orderId, document_id: documentId} = STOCK_TOOLS.saleads_stock_get_overview.input.parse(query);
    if (documentId && !await this.stock.documents.owns(businessId, documentId)) throw notFound();
    const overview = await this.stock.reads.overview(businessId);
    return STOCK_TOOLS.saleads_stock_get_overview.output.parse({...overview, ...(tarjeta ? {tarjeta: await this.stock.usage.reserveCard(businessId, tarjeta, orderId ?? documentId)} : {}),
      rotacion: await this.stock.rotation.alerts(businessId), facturas_sin_procesar: await this.stock.documents.unprocessed(businessId), avisos_canal: await this.stock.notices.takeForChannel(businessId),
      avisos_pendientes: await this.stock.alerts.pending(businessId)});
  }

  @Get('items/:variantId')
  @NoStore()
  async item(@Req() request: InternalRequest, @Param('businessId') raw: string, @Param('variantId') variantId: string, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    return STOCK_TOOLS.saleads_stock_get_item.output.parse(await this.stock.reads.itemDetail(businessId, idOf(variantId)));
  }

  @Get('proposals')
  @NoStore()
  async listProposals(@Req() request: InternalRequest, @Param('businessId') raw: string, @Query() query: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const {status, limit} = STOCK_TOOLS.saleads_stock_list_proposals.input.parse(query);
    return STOCK_TOOLS.saleads_stock_list_proposals.output.parse({propuestas: await this.stock.proposals.list(businessId, status, limit)});
  }

  @Post('proposals')
  @HttpCode(200)
  @NoStore()
  async propose(@Req() request: InternalRequest, @Param('businessId') raw: string, @Body() body: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    return StockProposeResponseV1.parse(await this.stock.proposals.create(request.internalUserId, businessId, 'mcp', body));
  }

  @Post('proposals/:id/confirm-count')
  @HttpCode(200)
  @NoStore()
  async confirmCount(@Req() request: InternalRequest, @Param('businessId') raw: string, @Param('id') id: string, @Body() body: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const input = STOCK_TOOLS.saleads_stock_confirm_count.input.parse(body);
    const proposalId = idOf(id);
    const {proposals} = this.stock;
    return StockProposalV1.parse(input.metodo === 'voz'
      ? await proposals.confirmByVoice(request.internalUserId, businessId, proposalId, input.revision, input.causa, input.reparto)
      : await proposals.confirmByChannel(request.internalUserId, businessId, proposalId, input.revision, input.cita!, input.session_id!, input.causa, input.reparto));
  }

  @Get('suppliers')
  @NoStore()
  async suppliers(@Req() request: InternalRequest, @Param('businessId') raw: string, @Query() query: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const {variante_id: variantId} = STOCK_TOOLS.saleads_stock_list_suppliers.input.parse(query);
    const plan = variantId ? await this.stock.suppliers.plan(businessId, variantId) : null;
    return STOCK_TOOLS.saleads_stock_list_suppliers.output.parse({...await this.stock.reads.suppliers(businessId, variantId), ...(plan ? {reposicion: plan} : {})});
  }

  @Get('orders')
  @NoStore()
  async orders(@Req() request: InternalRequest, @Param('businessId') raw: string, @Query() query: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    return STOCK_TOOLS.saleads_stock_list_orders.output.parse(await this.stock.reads.orders(businessId, STOCK_TOOLS.saleads_stock_list_orders.input.parse(query)));
  }

  @Get('bet-signal/:variantId')
  @NoStore()
  async betSignal(@Req() request: InternalRequest, @Param('businessId') raw: string, @Param('variantId') variantId: string, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    return STOCK_TOOLS.saleads_stock_get_bet_signal.output.parse(await this.stock.rotation.signal(request.internalUserId, businessId, idOf(variantId)));
  }

  @Post('photos')
  @HttpCode(200)
  @NoStore()
  async takePhoto(@Req() request: InternalRequest, @Param('businessId') raw: string, @Body() body: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const input = STOCK_TOOLS.saleads_stock_take_photo.input.parse(body);
    return STOCK_TOOLS.saleads_stock_take_photo.output.parse(await this.stock.photos.take(request.internalUserId, businessId, input));
  }

  @Get('photos/:id')
  @NoStore()
  async getPhoto(@Req() request: InternalRequest, @Param('businessId') raw: string, @Param('id') id: string, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    return STOCK_TOOLS.saleads_stock_get_photo.output.parse(await this.stock.photos.get(businessId, idOf(id)));
  }

  @Post('documents')
  @HttpCode(200)
  @NoStore()
  async documentRegister(@Req() request: InternalRequest, @Param('businessId') raw: string, @Body() body: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const tool = STOCK_TOOLS.saleads_stock_document_register;
    return tool.output.parse(await this.stock.documents.register(request.internalUserId, businessId, tool.input.parse(body)));
  }

  @Post('documents/:id/extract')
  @HttpCode(200)
  @NoStore()
  async documentExtract(@Req() request: InternalRequest, @Param('businessId') raw: string, @Param('id') id: string, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    return STOCK_TOOLS.saleads_stock_document_extract.output.parse(await this.stock.documents.extract(request.internalUserId, businessId, idOf(id)));
  }

  @Post('supplier/send')
  @HttpCode(200)
  @NoStore()
  async supplierSend(@Req() request: InternalRequest, @Param('businessId') raw: string, @Body() body: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const tool = STOCK_TOOLS.saleads_stock_supplier_send;
    return tool.output.parse(await this.stock.negotiation.send(request.internalUserId, businessId, tool.input.parse(body)));
  }

  @Get('supplier/wait')
  @NoStore()
  async supplierWait(@Req() request: InternalRequest, @Param('businessId') raw: string, @Query() query: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const tool = STOCK_TOOLS.saleads_stock_supplier_wait;
    return tool.output.parse(await this.stock.negotiation.wait(businessId, tool.input.parse(query)));
  }

  @Post('robot/say')
  @HttpCode(200)
  @NoStore()
  async robotSay(@Req() request: InternalRequest, @Param('businessId') raw: string, @Body() body: unknown, @Headers('x-business-id') header?: string) {
    const businessId = await this.business(request, raw, header);
    const {saleads_stock_robot_say: tool} = STOCK_TOOLS;
    const {texto} = (body ?? {}) as {texto?: unknown};
    if (typeof texto === 'string' && texto.length > STOCK_SAY_TEXT_MAX) throw stockTextTooLong();
    const input = tool.input.parse(body);
    // IVB-024: un aviso de Stock se dice por su `alerta_id`; el texto y las cifras los pone el servidor.
    if (input.alerta_id) return tool.output.parse(await this.stock.alerts.say(request.internalUserId, businessId, input.alerta_id, input.prioridad ?? 'normal'));
    return tool.output.parse(await this.stock.notices.say(request.internalUserId, businessId, input as Required<Omit<typeof input, 'alerta_id'>>));
  }
}
