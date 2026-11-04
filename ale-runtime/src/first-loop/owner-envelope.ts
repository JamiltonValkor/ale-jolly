import {z} from 'zod';

const PREFIX='SALEADS_OWNER_MESSAGE_V1 ';
const Envelope=z.object({client_message_id:z.uuid(),text:z.string().min(1).max(8000)}).strict();
/** Single JSON record prevents an owner literal from being mistaken for a server suffix. */
export function ownerMessage(client_message_id:string,text:string):string {
  return PREFIX+JSON.stringify(Envelope.parse({client_message_id,text}));
}
export function visibleOwnerMessage(value:string):string|null {
  if(value.startsWith(PREFIX)){
    try{return Envelope.parse(JSON.parse(value.split('\n',1)[0]!.slice(PREFIX.length))).text;}catch{return null;}
  }
  // Read compatibility only; previously stored payloads are never rewritten.
  return value.replace(/^CLIENT_MESSAGE_ID: [^\n]+\nOWNER_MESSAGE_DATA:\n/,'').split('\n\nSERVER_CONTEXT:')[0]!;
}
