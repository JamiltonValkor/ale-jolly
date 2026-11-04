import {ownerMessage,visibleOwnerMessage} from '../src/first-loop/owner-envelope';
const id='11111111-1111-4111-8111-111111111111';
describe('owner text and server context remain distinguishable',()=>{
  it('preserves original multilingual text, literal suffix markers and nested envelope-looking text',()=>{
    for(const text of ['Texto original\n\nSERVER_CONTEXT: una cita del usuario','SALEADS_OWNER_MESSAGE_V1 {"text":"literal"}','Português — original\nEnglish source quote'])
      expect(visibleOwnerMessage(ownerMessage(id,text)+'\n\nSERVER_CONTEXT: actual managed suffix')).toBe(text);
  });
  it('reads old history and rejects malformed technical envelopes without displaying them',()=>{
    expect(visibleOwnerMessage('CLIENT_MESSAGE_ID: '+id+'\nOWNER_MESSAGE_DATA:\nOriginal\n\nSERVER_CONTEXT: suffix')).toBe('Original');
    expect(visibleOwnerMessage('SALEADS_OWNER_MESSAGE_V1 malformed')).toBeNull();
    expect(()=>ownerMessage('invalid', 'Original')).toThrow();
  });
});
