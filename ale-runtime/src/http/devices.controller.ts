import {Body, Controller, Delete, Get, Header, HttpCode, Inject, Injectable, Optional, Param, Post, Req, Res, UseGuards,
  type CanActivate, type ExecutionContext} from '@nestjs/common';
import type {Response} from 'express';
import {CHAT_SERVICE, type ChatService} from '../chat/chat.service';
import {DeviceClaimRequestV1, DeviceClaimResponseV1, DevicesResponseV1, PairingPollRequestV1, PairingPollResponseV1,
  PairingStartRequestV1, PairingStartResponseV1, StreamRequestV1} from '../contracts/v1';
import {notFound, unauthorized} from '../domain/errors';
import {DEVICES_SERVICE, type DeviceIdentity, type DevicesService} from '../devices/devices.service';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';
import {CHAT_HEARTBEAT, pipeTurn} from './chat.controller';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Operaciones extra del canal robot. Solo existen con Stock encendido; el proveedor lo pone `app.module.ts`. */
export const STOCK_DEVICE_OPS = Symbol('STOCK_DEVICE_OPS');
export interface StockDeviceOps {
  enabledFor(userId: string): boolean;
  /** Nunca falla: si guardar la frase falla, el turno de voz sigue. */
  captureUtterance(device: DeviceIdentity, text: string): Promise<void>;
  handle(device: DeviceIdentity, body: unknown, response: Response): Promise<void>;
}

/** Petición de un robot emparejado: su credencial ya resolvió el dueño (y la bandera lo admite). */
export type DeviceRequest = AuthenticatedRequest & {device: DeviceIdentity};

/**
 * Credencial del robot (`Authorization: Bearer ale_dev_…`) → su dueño. Deja `principal` puesto para que
 * AssistantFlagGuard aplique la misma bandera que al chat web.
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(@Inject(DEVICES_SERVICE) private readonly devices: DevicesService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    const device = await this.devices.authenticate(request.headers.authorization);
    if (!device) throw unauthorized();
    request.device = device;
    request.principal = {userId: device.userId, clientId: 'robot'};
    return true;
  }
}

/**
 * Canal robot, lado del robot. Solo existe con `ROBOT_CHANNEL_ENABLED=true` (si no, 404). Rutas:
 * - `POST /devices/pairing` (pública): pide un código para mostrarlo en la cara del robot.
 * - `POST /devices/pairing/{id}/poll` (pública, con el secreto de sondeo): espera al dueño.
 * - `POST /devices/me/stream` (credencial del robot): un turno con Ale en la sesión del robot (SSE v1).
 */
@Controller('devices')
export class DevicesController {
  constructor(
    @Inject(DEVICES_SERVICE) private readonly devices: DevicesService,
    @Inject(CHAT_SERVICE) private readonly chat: ChatService,
    @Inject(CHAT_HEARTBEAT) private readonly heartbeatMs: number,
    @Optional() @Inject(STOCK_DEVICE_OPS) private readonly stock?: StockDeviceOps,
  ) {}

  @Post('pairing')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async start(@Body() body: unknown): Promise<PairingStartResponseV1> {
    const input = PairingStartRequestV1.parse(body ?? {});
    return PairingStartResponseV1.parse(await this.devices.startPairing(input.name));
  }

  @Post('pairing/:id/poll')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async poll(@Param('id') id: string, @Body() body: unknown): Promise<PairingPollResponseV1> {
    if (!UUID.test(id)) throw notFound();
    const input = PairingPollRequestV1.parse(body);
    return PairingPollResponseV1.parse(await this.devices.poll(id, input.poll_secret));
  }

  @Post('me/stream')
  @UseGuards(DeviceAuthGuard, AssistantFlagGuard)
  async stream(@Req() request: DeviceRequest, @Body() body: unknown, @Res() response: Response): Promise<void> {
    const stock = this.stock?.enabledFor(request.device.userId) ? this.stock : undefined;
    if (stock && typeof body === 'object' && body !== null && 'op' in body) return stock.handle(request.device, body, response);
    const input = StreamRequestV1.parse(body);
    await stock?.captureUtterance(request.device, input.text);
    const client = new AbortController();
    response.on('close', () => {if (!response.writableFinished) client.abort();});
    const turn = await this.chat.startDeviceTurn(request.device.userId, request.device.deviceId, input.text, client.signal,
      {voice: input.voice === true});
    await pipeTurn(response, client, turn, this.heartbeatMs);
  }
}

/** Canal robot, lado del dueño (sesión web): reclamar el código, ver y desvincular sus robots. */
@Controller('assistants/me/devices')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class AssistantDevicesController {
  constructor(@Inject(DEVICES_SERVICE) private readonly devices: DevicesService) {}

  @Post('claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async claim(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<DeviceClaimResponseV1> {
    const input = DeviceClaimRequestV1.parse(body);
    return DeviceClaimResponseV1.parse(await this.devices.claim(request.principal.userId, input.code));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: AuthenticatedRequest): Promise<DevicesResponseV1> {
    return DevicesResponseV1.parse(await this.devices.list(request.principal.userId));
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    if (!UUID.test(id)) throw notFound();
    await this.devices.revoke(request.principal.userId, id);
  }
}
