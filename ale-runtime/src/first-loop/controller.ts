import {Body,Controller,Get,Header,Headers,HttpCode,Inject,Param,Post,Put,Query,Req,UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {AuthGuard,type AuthenticatedRequest} from '../http/auth.guard';
import {AssistantFlagGuard} from '../http/assistant-flag.guard';
import {FirstLoopService} from './service';
import {FirstLoopMessageRequestV1,FirstLoopKickoffRequestV1,FirstLoopFeedbackRequestV1,ResponseLocaleV1} from './contracts';
import {notFound} from '../domain/errors';
import {LanguagePreferenceSyncV1} from '../locale/preferences';
const id=(s:string)=>{if(!z.uuid().safeParse(s).success)throw notFound();return s;};
@Controller('assistants/me/businesses/:businessId/first-loop')
@UseGuards(AuthGuard,AssistantFlagGuard)
export class FirstLoopController {
 constructor(@Inject(FirstLoopService) private readonly service:FirstLoopService){}
 @Get() @Header('Cache-Control','no-store') state(@Req() r:AuthenticatedRequest,@Param('businessId') b:string,@Query('response_locale') locale?:string){return this.service.state(r.principal.userId,id(b),locale===undefined?undefined:ResponseLocaleV1.parse(locale));}
 @Post('messages') @HttpCode(202) @Header('Cache-Control','no-store') message(@Req() r:AuthenticatedRequest,@Param('businessId') b:string,@Body() body:unknown){return this.service.message(r.principal.userId,id(b),FirstLoopMessageRequestV1.parse(body));}
 @Get('messages/:clientMessageId') @Header('Cache-Control','no-store') receipt(@Req() r:AuthenticatedRequest,@Param('businessId') b:string,@Param('clientMessageId') c:string){return this.service.messageReceipt(r.principal.userId,id(b),id(c));}
 @Post('kickoff') @HttpCode(202) @Header('Cache-Control','no-store') kickoff(@Req() r:AuthenticatedRequest,@Param('businessId') b:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.service.kickoff(r.principal.userId,id(b),FirstLoopKickoffRequestV1.parse(body),key);}
 @Get('works/:workId') @Header('Cache-Control','no-store') work(@Req() r:AuthenticatedRequest,@Param('businessId') b:string,@Param('workId') w:string){return this.service.work(r.principal.userId,id(b),id(w));}
 @Post('works/:workId/feedback') @HttpCode(202) @Header('Cache-Control','no-store') feedback(@Req() r:AuthenticatedRequest,@Param('businessId') b:string,@Param('workId') w:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.service.feedback(r.principal.userId,id(b),id(w),FirstLoopFeedbackRequestV1.parse(body),key);}
}

/** The authenticated BFF mirrors Subscription's saved preference before requesting assistant work. */
@Controller('assistants/me/preferences/language')
@UseGuards(AuthGuard,AssistantFlagGuard)
export class FirstLoopLanguageController {
 constructor(@Inject(FirstLoopService) private readonly service:FirstLoopService){}
 @Put() @Header('Cache-Control','no-store') synchronize(@Req() r:AuthenticatedRequest,@Body() body:unknown){return this.service.synchronizeLanguage(r.principal.userId,LanguagePreferenceSyncV1.parse(body));}
}
