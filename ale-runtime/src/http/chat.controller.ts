import {Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req, Res, UseGuards} from '@nestjs/common';
import type {Response} from 'express';
import {sseFrame} from '../chat/chat-events';
import {CHAT_SERVICE, type ChatService} from '../chat/chat.service';
import {MessagesResponseV1, SessionResponseV1, StreamEventV1, StreamRequestV1} from '../contracts/v1';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';

export const CHAT_HEARTBEAT = Symbol('CHAT_HEARTBEAT');

/** Comentario SSE: mantiene viva la conexión (idle del gateway = 600 s); el front lo ignora. */
const KEEPALIVE = ': keepalive\n\n';

/**
 * Chat del asistente (OCB-011). Mismos guards que /assistants/me: token web
 * (401) y bandera (403/503). Sin asistente o sesión ajena → 404 NOT_FOUND;
 * asistente que no está en `ready` → 409 ASSISTANT_NOT_READY.
 *
 * El cuerpo del stream lleva el mensaje del dueño: nunca se registra, y un
 * cuerpo inválido responde el error fijo de SafeErrorFilter.
 */
@Controller('assistants')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class ChatController {
  constructor(
    @Inject(CHAT_SERVICE) private readonly chat: ChatService,
    @Inject(CHAT_HEARTBEAT) private readonly heartbeatMs: number,
  ) {}

  @Post('me/sessions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async createSession(@Req() request: AuthenticatedRequest): Promise<SessionResponseV1> {
    return SessionResponseV1.parse(await this.chat.createSession(request.principal.userId));
  }

  @Get('me/sessions/:id/messages')
  @Header('Cache-Control', 'no-store')
  async messages(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<MessagesResponseV1> {
    return MessagesResponseV1.parse(await this.chat.history(request.principal.userId, id));
  }

  /**
   * SSE v1: cada evento se escribe en cuanto llega de Hermes (sin buffer). Si
   * el cliente cierra, se aborta la llamada a Hermes.
   */
  @Post('me/sessions/:id/stream')
  async stream(
    @Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown, @Res() response: Response,
  ): Promise<void> {
    const input = StreamRequestV1.parse(body);
    const client = new AbortController();
    response.on('close', () => {if (!response.writableFinished) client.abort();});
    const turn = await this.chat.startTurn(request.principal.userId, id, input.text, client.signal, {voice: input.voice === true});
    await pipeTurn(response, client, turn, this.heartbeatMs);
  }
}

/**
 * SSE v1 de un turno ya abierto (chat web y canal robot): cada evento se escribe en cuanto llega,
 * con keepalive y respetando la contrapresión.
 */
export async function pipeTurn(
  response: Response, client: AbortController, turn: AsyncGenerator<StreamEventV1>, heartbeatMs: number,
): Promise<void> {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  response.socket?.setNoDelay(true);
  const heartbeat = setInterval(() => {if (!response.writableEnded) response.write(KEEPALIVE);}, heartbeatMs);
  heartbeat.unref();
  try {
    for await (const event of turn) {
      if (client.signal.aborted) break;
      await write(response, sseFrame(StreamEventV1.parse(event)));
    }
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

/** Escribe y respeta la contrapresión: con el buffer lleno espera `drain` (o el cierre). */
function write(response: Response, chunk: string): Promise<void> {
  if (response.write(chunk)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {response.off('drain', done); response.off('close', done); resolve();};
    response.once('drain', done);
    response.once('close', done);
  });
}
