// Contrato con los CLIENTES REALES de ale-runtime (compilados), no con una copia:
// levanta cloud-sim con el driver falso y recorre lo que hace el servicio.
//
//   cd <ale-runtime> && npx tsc -p tsconfig.build.json --outDir <dist>
//   NODE_PATH=<ale-runtime>/node_modules ALE_RUNTIME_DIST=<dist> node cloud-sim/tests/runtime_clients.cjs
'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dist = process.env.ALE_RUNTIME_DIST;
if (!dist) { console.error('ALE_RUNTIME_DIST is required'); process.exit(2); }
const src = p => require(path.join(dist, 'src', p));
const {outboundFetch} = src('outbound/http-client');
const {MetadataServerTokenSource} = src('compute/gcp-token');
const {RestLifecycleCompute} = src('lifecycle/lifecycle-compute');
const {RestInstanceMetadata} = src('renewal/instance-metadata');
const {RestInstanceClient} = src('compute/instance-client');
const {mergeMetadata, computeAppliedVersion, withMetadataValues} = src('compute/metadata');
const {instanceNameFor, insertRequestId} = src('compute/instance-name');
const archive = src('lifecycle/memory-archive');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'ale-local', ZONE = 'local-sim1-a';
const TEMPLATE = `projects/${PROJECT}/global/instanceTemplates/sa-assistant-local`;
const BUCKET = 'ale-local-assistant-memories';
const EMAIL = 'sa-assistant-service@ale-local.iam.gserviceaccount.com';
const USER = '00000000-0000-4000-a000-000000000001';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sim-'));
  fs.writeFileSync(path.join(tmp, 'startup-script.sh'), '#!/bin/bash\necho watcher\n');
  const sim = spawn('python3', ['-m', 'cloudsim'], {
    cwd: path.join(__dirname, '..'),
    env: {...process.env, CLOUD_SIM_DRIVER: 'fake', CLOUD_SIM_PORT: String(PORT), CLOUD_SIM_DATA: tmp,
      CLOUD_SIM_STARTUP_SCRIPT: path.join(tmp, 'startup-script.sh'), CLOUD_SIM_OP_DELAY_SEC: '0.05',
      GCP_PROJECT: PROJECT, GCP_ZONE: ZONE},
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* aún no */ }
      if (i > 100) throw new Error('cloud-sim did not start');
      await new Promise(r => setTimeout(r, 100));
    }
    await run();
    console.log('runtime clients contract: OK');
  } finally {
    sim.kill();
  }
}

async function run() {
  const fetcher = outboundFetch({userAgent: 'SaleADS-Assistant-Service/0.1 (+test)', timeoutMs: 10_000});
  const tokens = new MetadataServerTokenSource(fetcher, `${BASE}/token`);
  assert.ok(await tokens.token());
  const location = {project: PROJECT, zone: ZONE, template: TEMPLATE, apiBase: `${BASE}/compute/v1`};
  const compute = new RestLifecycleCompute(location, tokens, fetcher);
  const metadataApi = new RestInstanceMetadata({project: PROJECT, apiBase: location.apiBase}, tokens, fetcher,
    {operationTimeoutMs: 10_000, pollIntervalMs: 50});
  const instances = new RestInstanceClient(metadataApi, ZONE);
  const until = async (what, fn) => {
    for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`timeout: ${what}`);
  };

  // Provisioner: plantilla + merge + insert + operación.
  const template = await compute.templateMetadata();
  assert.ok(template.some(item => item.key === 'startup-script'));
  const name = instanceNameFor(USER, 'local');
  const items = mergeMetadata(template, {'hermes-api-key': 'k'.repeat(32), 'hermes-config': 'timezone: UTC\n'});
  const requestId = insertRequestId(USER, 1, Date.now(), 'local');
  const created = await compute.insertInstance({name, items, requestId});
  assert.equal(created.kind, 'created');
  await until('insert DONE', async () => (await compute.operationStatus(created.operation)).done);
  assert.equal((await compute.operationStatus(created.operation)).errorReason, null);
  const again = await compute.insertInstance({name, items, requestId: insertRequestId(USER, 2, Date.now(), 'local')});
  assert.deepEqual(again, {kind: 'exists'});

  // Readiness / IA: get con generación, IP y fingerprint.
  const view = await instances.getInstance(name);
  assert.equal(view.status, 'RUNNING');
  assert.match(view.generation, /^\d+$/);
  assert.match(view.privateIp, /^(\d{1,3}\.){3}\d{1,3}$/);
  assert.deepEqual(view.items, items);
  assert.equal(await instances.getInstance('sa-assistant-' + 'f'.repeat(32)), null);

  // Ack del watcher por guest attributes, en las dos formas de lectura.
  const expected = computeAppliedVersion(view.items);
  assert.equal(await instances.guestAttribute(name, 'hermes/applied-version'), null);
  await vmPut(name, 'hermes/applied-version', expected);
  await vmPut(name, 'hermes/watcher-version', '11');
  assert.equal(await instances.guestAttribute(name, 'hermes/applied-version'), expected);
  assert.equal(await compute.guestAttribute(name, 'hermes', 'watcher-version'), '11');
  assert.equal(await compute.guestAttribute(name, 'hermes', 'archive-status'), null);

  // setMetadata con fingerprint; el viejo da conflicto (412).
  const next = withMetadataValues(view.items, {'hermes-env': 'A=1\n'});
  await instances.setMetadata(name, view.fingerprint, next);
  await assert.rejects(instances.setMetadata(name, view.fingerprint, next), err => err.status === 412);
  const info = await compute.instanceInfo(name);
  assert.deepEqual(info.items, next);
  const opName = await compute.replaceMetadata(name, info.fingerprint, info.items);
  await until('setMetadata DONE', async () => (await compute.operationStatus(opName)).done);

  // Archivo: URL firmada (IAM signBlob) que sube la VM; el servicio comprueba que exista.
  const signer = new archive.IamCredentialsSigner(EMAIL, `${BASE}/v1`, tokens, fetcher);
  const archiver = new archive.GcsMemoryArchiver(signer, new archive.GcsArchiveStore(BASE, tokens, fetcher));
  const object = archive.archiveObjectName(USER, new Date());
  const putUrl = await archiver.signedUploadUrl({bucket: BUCKET, object, now: new Date(), ttlSeconds: 900});
  assert.ok(putUrl.startsWith('https://storage.googleapis.com/'));
  assert.equal(await archiver.objectExists(BUCKET, object), false);
  const local = putUrl.replace('https://storage.googleapis.com', BASE);
  const put = await fetch(local, {method: 'PUT', headers: {'content-type': 'application/gzip'}, body: Buffer.from('tgz-bytes')});
  assert.equal(put.status, 200);
  assert.equal(await archiver.objectExists(BUCKET, object), true);
  const lister = new archive.GcsObjectLister(BASE, tokens, fetcher);
  const listed = await lister.list(BUCKET, `${USER}/`);
  assert.equal(archive.latestArchiveObject(USER, listed), object);
  const getUrl = (await archive.signedGetUrlV4({bucket: BUCKET, object, now: new Date(), ttlSeconds: 3600, signer})).url;
  const got = await fetch(getUrl.replace('https://storage.googleapis.com', BASE));
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), 'tgz-bytes');

  // Escritura y lectura por la JSON API (semilla, Stock).
  await new archive.GcsObjectWriter(BASE, tokens, fetcher).upload(BUCKET, 'seed/a b.json', Buffer.from('{"x":1}'), 'application/json');
  const reader = new archive.GcsObjectReader(BASE, tokens, fetcher);
  assert.equal((await reader.download(BUCKET, 'seed/a b.json', 1024)).toString(), '{"x":1}');
  assert.equal(await reader.download(BUCKET, 'seed/missing.json', 1024), null);

  // Stop / start / delete.
  const stop = await compute.stopInstance(name);
  await until('stop', async () => (await compute.operationStatus(stop)).done);
  assert.equal((await compute.instanceInfo(name)).status, 'TERMINATED');
  const start = await compute.startInstance(name);
  await until('start', async () => (await compute.operationStatus(start)).done);
  assert.equal((await compute.instanceInfo(name)).status, 'RUNNING');
  const del = await compute.deleteInstance(name);
  await until('delete', async () => (await compute.operationStatus(del)).done);
  assert.equal(await compute.instanceInfo(name), null);
  assert.equal(await compute.deleteInstance(name), null);
}

async function vmPut(name, key, value) {
  const res = await fetch(`${BASE}/vm/${name}/computeMetadata/v1/instance/guest-attributes/${key}`,
    {method: 'PUT', headers: {'Metadata-Flavor': 'Google'}, body: value});
  assert.equal(res.status, 200);
}

main().catch(err => { console.error(err); process.exit(1); });
