import {createHash} from 'node:crypto';
import {signedPutUrlV4, type BlobSigner} from '../src/lifecycle/memory-archive';

/** Vector de la firma sin `contentType` para la fecha de la prueba: el archivo de memorias no puede cambiar ni un byte. */
const VECTOR = 'https://storage.googleapis.com/saleads-dev-assistant-memories/u%3A1/20271015T120000Z.tgz?X-Goog-Algorithm=GOOG4-RSA-SHA256'
  + '&X-Goog-Credential=sa-assistant-service%40saleads-dev.iam.gserviceaccount.com%2F20271015%2Fauto%2Fstorage%2Fgoog4_request'
  + '&X-Goog-Date=20271015T120000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=content-type%3Bhost'
  + '&X-Goog-Signature=899d9475091f82bbacd8508ccc3985daf300af3694b25f25e1ce61bd5a3d51a8';

const signer: BlobSigner = {email: 'sa-assistant-service@saleads-dev.iam.gserviceaccount.com', sign: async payload => createHash('sha256').update(payload).digest()};
const base = {bucket: 'saleads-dev-assistant-memories', object: 'u:1/20271015T120000Z.tgz', now: new Date('2027-10-15T12:00:00.000Z'), ttlSeconds: 900, signer};

describe('firma del PUT', () => {
  it('sin contentType produce exactamente la URL de siempre', async () => {
    expect((await signedPutUrlV4(base)).url).toBe(VECTOR);
  });

  it('con contentType el canónico firma ese valor y la URL cambia', async () => {
    const parts = await signedPutUrlV4({...base, contentType: 'image/jpeg'});
    expect(parts.canonicalRequest).toContain('content-type:image/jpeg\n');
    expect(parts.canonicalRequest).not.toContain('application/gzip');
    expect(parts.url).not.toBe(VECTOR);
  });
});
