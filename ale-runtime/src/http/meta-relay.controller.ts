import {Body, Controller, Inject, Post, Req, Res} from '@nestjs/common';
import type {Request, Response} from 'express';
import {MetaInferenceRelay} from '../ai/meta-relay';

/** The VM uses its own inference-only bearer; web OAuth tokens do not authorize this route. */
@Controller('meta-inference/v1')
export class MetaRelayController {
  constructor(@Inject(MetaInferenceRelay) private readonly relay: MetaInferenceRelay) {}

  @Post('responses')
  async responses(@Req() request: Request, @Body() body: unknown, @Res() response: Response): Promise<void> {
    const abort = new AbortController();
    const close = () => {if (!response.writableFinished) abort.abort();};
    response.once('close', close);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const upstream = await this.relay.responses(request.headers.authorization, body, abort.signal);
      reader = upstream.body!.getReader();
      response.status(upstream.status);
      response.setHeader('Content-Type', upstream.headers.get('content-type')!);
      response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      response.socket?.setNoDelay(true);
      while (!abort.signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        if (abort.signal.aborted || response.destroyed) break;
        await write(response, next.value);
      }
      if (!response.destroyed && !response.writableEnded) response.end();
    } catch (error) {
      if (abort.signal.aborted || response.destroyed) return;
      if (response.headersSent) {response.destroy(); return;}
      throw error;
    } finally {
      response.off('close', close);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }
}

function write(response: Response, chunk: Uint8Array): Promise<void> {
  if (response.write(chunk)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {response.off('drain', done); response.off('close', done); resolve();};
    response.once('drain', done);
    response.once('close', done);
  });
}
