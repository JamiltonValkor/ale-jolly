import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {StockRobotSayInputV1} from '../src/contracts/stock-v1';
import {isAffirmative} from '../src/stock/proposals';
import {CANONICAL_SESSION_PLACEHOLDER, scopedJobPrompt} from '../src/notifications/jobs';
import {ADDON_DIR} from './support/stock-addon';

/**
 * IVB-023: lo que el simulador encontró en dev y se corrige en el texto del complemento 1.0.1. Son reglas de conducta del
 * modelo, así que la prueba fija que el texto exista donde se carga (prompt del tick, skill de Ale, skills de Stock).
 */
const read = (path: string) => readFileSync(join(ADDON_DIR, path), 'utf8');
const tick = () => (JSON.parse(read('jobs.json')) as {jobs: Array<{name: string; prompt: string}>}).jobs.find(job => job.name === 'saleads:stock-tick')!.prompt;
const orchestration = () => read('skills/saleads-stock-orchestration/SKILL.md');

describe('complemento 1.0.1 a 1.0.8: hallazgos del simulador (IVB-023), del ensayo y de la oficial E2E (IVB-024)', () => {
  it('versión 1.0.8 en el manifiesto', () => {
    expect(JSON.parse(read('manifest.json'))).toMatchObject({version: '1.0.8', variant: 'stock-1.0.8'});
  });

  it('1. el tick abre la negociación de un pedido antes que la tarjeta de tick', () => {
    const prompt = tick();
    const negotiation = prompt.indexOf('tarjeta=negociar');
    const tickCard = prompt.indexOf('tarjeta=tick');
    expect(negotiation).toBeGreaterThan(-1);
    expect(tickCard).toBeGreaterThan(negotiation);
    expect(prompt).toMatch(/en vez de la de tick/);
    expect(orchestration()).toMatch(/La negociación va primero/);
  });

  it('2. lo pedido por voz vuelve a la voz', () => {
    expect(orchestration()).toMatch(/`origen: voz`/);
    expect(orchestration()).toMatch(/vuelve a la voz con `saleads_stock_robot_say`/);
    expect(read('SOUL.addendum.md')).toMatch(/Lo que se pidió por voz se responde por voz/);
  });

  it('3. R22: el tick revisa cada apuesta vigente y el estratega baja la pauta si no alcanza', () => {
    expect(tick()).toMatch(/Con alcance_pauta no_alcanza, tarjeta al estratega para bajarla/);
    expect(orchestration()).toMatch(/Por cada apuesta aprobada y vigente, lee `saleads_stock_get_bet_signal`/);
    expect(read('profiles/stock/skills/stock-reposicion/SKILL.md')).toMatch(/el estratega decide si baja la pauta\. Tú no la propones/);
  });

  it('4. R20c: id de variante, «sin stock» solo con saldo 0, y sin costo no hay kit ni apuesta', () => {
    const skill = orchestration();
    expect(skill).toMatch(/recibe un `variante_id`/);
    expect(skill).toMatch(/Solo di que no hay stock si `stock\.saldo` es 0/);
    expect(skill).toMatch(/Sin costo \(`costo\.fuente` es `sin_dato`\) no hay margen: ni pauta ni kit/);
    expect(read('profiles/stock/skills/stock-reposicion/SKILL.md')).toMatch(/Sin costo no es alerta para marketing/);
    expect(read('profiles/stock/skills/stock-reposicion/SKILL.md')).toMatch(/No reportes «sin stock» si el saldo es mayor a 0/);
  });

  it('5. R8/R8b en el tick: factura por canal, nunca a la cámara', () => {
    expect(tick()).toMatch(/se pide por el canal del asistente, nunca a la cámara/);
    expect(orchestration()).toMatch(/o que conecte el canal en SaleADS\. Nunca le pidas mostrarla a la cámara/);
    expect(orchestration()).toMatch(/Nunca pidas mostrarla a la cámara de Jolly/);
  });

  it('5. R15: Stock no reparte variantes y Ale pregunta con opciones', () => {
    expect(read('profiles/stock/skills/stock-vision/SKILL.md')).toMatch(/no elijas ni repartas el total entre variantes/);
    expect(orchestration()).toMatch(/no repartas ni sugieras un reparto\. Pregunta con `saleads_stock_robot_say`, `pregunta:true`/);
  });

  it('1.0.2, R15 en el servidor: variante_por_confirmar, reparto con la frase del dueño y conceptos que separan objetos', () => {
    expect(read('profiles/stock/skills/stock-vision/SKILL.md')).toMatch(/`estado:"variante_por_confirmar"`/);
    expect(read('profiles/stock/skills/stock-vision/SKILL.md')).toMatch(/un concepto por variante que las distinga/);
    expect(read('profiles/stock/skills/stock-inventario/SKILL.md')).toMatch(/no propongas otra vez por variante/);
    expect(orchestration()).toMatch(/`saleads_stock_confirm_count` con `reparto`/);
    expect(orchestration()).toMatch(/Un «sí» a un reparto tuyo no confirma/);
    expect(orchestration()).not.toMatch(/¿cuántas son reparador y cuántas hidratante/);
  });

  it('memoria: los números salen de las herramientas del turno', () => {
    expect(tick()).toMatch(/sale de este turno, nunca de lo que recuerdes del objetivo/);
    expect(read('SOUL.addendum.md')).toMatch(/Un conteo o un saldo de otro turno o de otra corrida no vale/);
  });

  it('foto nueva sin photo_id (IVB-027)', () => {
    expect(read('profiles/stock/skills/stock-vision/SKILL.md')).toMatch(/Una foto nueva va sin `photo_id`/);
  });

  describe('1.0.3, factura huérfana (IVB-024, ensayo 1)', () => {
    const stockInventory = () => read('profiles/stock/skills/stock-inventario/SKILL.md');

    it('la factura que llega con otra tarjeta en curso tiene su tarjeta en ese turno, con clave por documento', () => {
      expect(orchestration()).toMatch(/La única excepción es la tarjeta `factura` de un documento registrado: nace siempre en ese mismo turno, aunque haya otra en curso/);
      expect(orchestration()).toMatch(/En ese mismo turno, pide `saleads_stock_get_overview` con `tarjeta:"factura"` y `document_id`/);
      expect(orchestration()).toMatch(/un comentario no basta/);
      expect(read('SOUL.addendum.md')).toMatch(/le creas su tarjeta `factura` en ese mismo turno, con `tarjeta:"factura"` y su `document_id`, aunque haya otra en curso\. Un comentario no basta/);
      // La regla de una en curso sigue para todo lo demás.
      expect(read('SOUL.addendum.md')).toContain('Máximo 1 tarjeta Stock en curso por negocio');
    });

    it('el pedido que esperaba la factura se desbloquea y no se queda esperando el tick', () => {
      expect(orchestration()).toMatch(/Si estaba bloqueada por la factura, usa `kanban_unblock`/);
    });

    it('el tick procesa los documentos sin procesar antes que la negociación y que la tarjeta de tick', () => {
      const prompt = tick();
      const invoices = prompt.indexOf('facturas_sin_procesar');
      expect(invoices).toBeGreaterThan(-1);
      expect(prompt.indexOf('tarjeta=negociar')).toBeGreaterThan(invoices);
      expect(prompt.indexOf('tarjeta=tick')).toBeGreaterThan(invoices);
      expect(prompt).toMatch(/tarjeta=factura y ese document_id/);
      expect(orchestration()).toMatch(/no tiene factura y `facturas_sin_procesar` viene vacío, pídela/);
      const skill = orchestration();
      expect(skill.indexOf('Las facturas van primero')).toBeGreaterThan(-1);
      expect(skill.indexOf('Las facturas van primero')).toBeLessThan(skill.indexOf('La negociación va primero'));
    });

    it('un bloqueo por factura o documento dispara la tarjeta de extracción sin esperar al tick', () => {
      expect(orchestration()).toMatch(/Si Stock bloquea una tarjeta por una factura, un documento o una entrada, no esperes al tick\. Lee `saleads_stock_get_overview`: por cada documento de `facturas_sin_procesar` crea su tarjeta `factura`/);
    });

    it('Stock procesa en la misma tarjeta un documento ya registrado y no bloquea esperando el tick', () => {
      expect(stockInventory()).toMatch(/trae un `document_id`, o `saleads_stock_get_overview` lo lista en `facturas_sin_procesar`, procésalo en esa misma tarjeta/);
      expect(stockInventory()).toMatch(/No bloquees esperando al tick un documento que ya está registrado/);
    });

    it('Ale no dice que se lo pasó a Stock sin haberlo hecho con una herramienta', () => {
      expect(orchestration()).toMatch(/## Lo que dices que hiciste/);
      expect(orchestration()).toMatch(/si en este turno lo hiciste con `kanban_create`, `kanban_comment` o `kanban_unblock` y la herramienta respondió bien/);
      expect(orchestration()).toMatch(/«Todavía no se la pasé a Stock», y hazlo en ese turno/);
      expect(read('SOUL.addendum.md')).toMatch(/Nunca digas que le pasaste algo a Stock si no lo hiciste en este turno con una herramienta que respondió bien/);
    });
  });

  describe('1.0.4 → 1.0.7, los avisos de Stock salen del servidor y no se quedan en [SILENT] (IVB-024)', () => {
    const reorder = () => read('profiles/stock/skills/stock-reposicion/SKILL.md');
    const ADDON_FILES = ['jobs.json', 'SOUL.addendum.md', 'skills/saleads-stock-orchestration/SKILL.md', 'profiles/stock/SOUL.md',
      'profiles/stock/skills/stock-reposicion/SKILL.md', 'profiles/stock/skills/stock-inventario/SKILL.md', 'profiles/stock/skills/stock-vision/SKILL.md',
      'profiles/stock/skills/stock-negociacion/SKILL.md', 'profiles/investigador/skills/saleads-offer-kit/SKILL.md'];

    it('Stock describe alertas en su resultado pero no escribe líneas AVISO: como fuente de verdad', () => {
      expect(reorder()).toMatch(/## Alertas/);
      for (const tipo of ['`estancado`', '`cobertura`', '`reponer`']) expect(reorder()).toContain(`- ${tipo}:`);
      expect(reorder()).toMatch(/`estancado`: `frenazo`, `lento` o `sin_pauta` en `rotacion`, con saldo mayor a 0 y costo/);
      expect(reorder()).toMatch(/el servidor calcula los avisos \(`avisos_pendientes`\) y Ale los dice por su `alerta_id`\. No escribas líneas `AVISO:`/);
      expect(read('profiles/stock/SOUL.md')).toMatch(/No escribas líneas `AVISO:`/);
      for (const file of ADDON_FILES) expect(read(file)).not.toMatch(/`AVISO: <tipo>|AVISO: estancado \||AVISO: reponer`/);
    });

    it('R18 sigue: el estado de rotación es del servidor, y sano o sin datos no es alerta', () => {
      expect(reorder()).toMatch(/nunca declares frenazo ni lento por tu cuenta \(R18\)/);
      expect(reorder()).toMatch(/Sano o `sin_datos` no es alerta/);
      expect(reorder()).toMatch(/Una semana sin ventas no declara lento un producto/);
    });

    it('ninguna regla manda leer avisos del tablero ni decidir por memoria qué ya se dijo', () => {
      for (const file of ADDON_FILES) {
        const text = read(file);
        expect(text).not.toMatch(/cuyos avisos no dijiste|que no hayas dicho|avisos no dijiste/);
        // Ninguna oración junta avisos con leer el tablero, salvo para prohibirlo.
        for (const sentence of text.split(/(?<=[.!?])\s+/)) {
          if (/aviso/i.test(sentence) && /kanban_list|kanban_show|tablero/.test(sentence)) expect(sentence).toMatch(/Nunca busques avisos en el tablero/);
        }
      }
      expect(orchestration()).toMatch(/Nunca decidas por lo que recuerdes si un aviso ya se dijo o es repetido\. Eso lo sabe el servidor/);
      expect(tick()).toMatch(/Nunca busques avisos en el tablero ni decidas por memoria qué ya se dijo/);
      expect(read('SOUL.addendum.md')).toMatch(/Nunca busques avisos en el tablero ni decidas por memoria si ya se dijeron/);
    });

    it('el tick dice cada aviso de avisos_pendientes por su alerta_id, sin redactarlo, y no insiste con ya_dicho o no_vigente', () => {
      const prompt = tick();
      expect(prompt).toMatch(/por cada entrada de avisos_pendientes de saleads_stock_get_overview, llama saleads_stock_robot_say solo con su alerta_id, sin texto ni dedupe_key, en este turno y antes de terminar/);
      expect(prompt).toMatch(/Con ya_dicho o no_vigente, no insistas/);
      const skill = orchestration();
      expect(skill).toMatch(/Por cada entrada de `avisos_pendientes`, llama `saleads_stock_robot_say` solo con su `alerta_id` \(y `prioridad` si hace falta\), sin texto, pregunta, ids ni `dedupe_key`/);
      for (const tipo of ['`frenazo`', '`lento`', '`sin_pauta`', '`cobertura`', '`pegando`']) expect(skill).toContain(tipo);
      expect(skill).toMatch(/Ese texto nunca empieza con «AVISO:» y su `dedupe_key` nunca empieza con `alerta` ni `stock-alerta`/);
      expect(skill).toMatch(/Con `ya_dicho` o `no_vigente`, no insistas ni lo reescribas/);
      expect(skill).toMatch(/Con `robot_offline` no se creó nada: el aviso sigue en `avisos_pendientes`.*No lo mandes por canal/);
    });

    it('al terminar una tarjeta de Stock con alertas, la sesión del dueño lee get_overview y dice avisos_pendientes', () => {
      expect(orchestration()).toMatch(/Si el resultado describe alertas, no las digas desde ese texto ni decidas por lo que recuerdes si ya se dijeron: llama `saleads_stock_get_overview` y di lo que traiga `avisos_pendientes`/);
    });

    it('un aviso pendiente no cuenta como [SILENT], y las respuestas de voz siguen con robot_say libre', () => {
      expect(tick()).toMatch(/Si avisos_pendientes viene vacío y nada necesita al dueño, responde exactamente \[SILENT\]/);
      expect(tick().trimEnd().endsWith('responde exactamente [SILENT].')).toBe(true);
      expect(orchestration()).toMatch(/Con avisos pendientes, nunca cierres con `\[SILENT\]` sin haber llamado `saleads_stock_robot_say` por cada uno/);
      expect(orchestration()).toMatch(/Las respuestas a un turno de voz y el resultado del ciclo con marketing siguen con `saleads_stock_robot_say` de texto libre/);
      expect(orchestration()).toMatch(/vuelve a la voz con `saleads_stock_robot_say`/);
    });

    it('robot_say de texto libre (respuestas de voz) sigue cabiendo en el contrato', () => {
      const parsed = StockRobotSayInputV1.safeParse({
        texto: 'El Sérum Capilar vendía 5,13 por semana y esta semana va en 0. Quedan 12. Ventas simuladas.', pregunta: false, proposal_id: null,
        producto_id: '6581ac3a-f274-4e2f-b9ca-3161e124d4b9', prioridad: 'normal', dedupe_key: 'stock-alerta:e96df7a4-ac36-4c52-9f19-800c35101688',
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('1.0.4, confirmación y producto nombrado (IVB-024, oficial 321e84d9, P5)', () => {
    it('F-P5a: confirm_count solo responde a la pregunta de confirmar ese conteo', () => {
      const skill = orchestration();
      expect(skill).toMatch(/Llama `saleads_stock_confirm_count` solo cuando la frase del dueño responde a la pregunta de confirmar ese conteo/);
      expect(skill).toMatch(/Una respuesta a otra pregunta no confirma, aunque empiece con «sí»: «Sí, son Bio Mascarilla de 500 gramos» solo dice de qué producto es/);
      expect(skill).toMatch(/La única excepción es el reparto de variantes/);
      // La regla va antes que la del reparto, que sigue igual.
      expect(skill.indexOf('solo cuando la frase del dueño responde')).toBeLessThan(skill.indexOf('`saleads_stock_confirm_count` con `reparto`'));
    });

    it('F-P5a: un conteo pendiente se explica y se dice qué frase lo confirma', () => {
      expect(orchestration()).toMatch(/Si un conteo queda pendiente, dile al dueño por qué/);
      expect(orchestration()).toMatch(/«Di "confirmo" y lo registro» o «confírmalo en la pantalla de Stock», con el `enlace`/);
    });

    it('F-P5b: el producto que nombró el dueño va en la tarjeta y en la etiqueta de la foto', () => {
      expect(orchestration()).toMatch(/si el dueño nombró el producto .*pon en el cuerpo `producto: <lo que dijo>`/);
      expect(orchestration()).toMatch(/Nunca pongas un lugar genérico \(«repisa», «estante»\) en lugar del producto que nombró/);
      expect(read('profiles/stock/skills/stock-vision/SKILL.md')).toMatch(/la `etiqueta` es ese producto, hasta 40 caracteres, nunca un lugar como «repisa»/);
      const inventory = read('profiles/stock/skills/stock-inventario/SKILL.md');
      expect(inventory).toMatch(/Si la tarjeta trae el producto que nombró el dueño, cuentas ese producto: no preguntes de qué producto es/);
      // Sin producto nombrado, la foto va primero (etiqueta «por identificar»): Stock lo reconoce o pregunta con el total.
      expect(inventory).toMatch(/Si la tarjeta no nombra producto .*no bloquees ni preguntes antes de mirar/);
      expect(read('profiles/stock/skills/stock-vision/SKILL.md')).toMatch(/Si la tarjeta no nombra producto, la `etiqueta` es `por identificar`/);
      expect(orchestration()).toMatch(/coméntale `producto: <lo que dijo>` y usa `kanban_unblock` en ese mismo turno/);
      expect(orchestration()).toMatch(/Nunca le pidas al dueño que te mande ni que tome una foto para contar/);
      // R15 no se afloja: con variantes que la foto no distingue, sigue preguntando.
      expect(inventory).toMatch(/la foto no las distingue \(R15\)/);
    });

    it('F-P5a: el servidor no toma «Sí, son …» como confirmación', () => {
      expect(isAffirmative('Sí, son Bio Mascarilla de 500 gramos')).toBe(false);
      expect(isAffirmative('confirmo')).toBe(true);
    });
  });

  describe('1.0.4, pantallazo y seguimiento de la pauta (IVB-024, oficial 321e84d9, P5)', () => {
    const reorder = () => read('profiles/stock/skills/stock-reposicion/SKILL.md');
    const between = (from: string, to: string) => {
      const skill = orchestration();
      return skill.slice(skill.indexOf(from), skill.indexOf(to, skill.indexOf(from) + from.length));
    };

    it('F-P5c: un pantallazo nunca va a extracción, Stock lo cita como evidencia y solo una factura pide PDF', () => {
      const pantallazo = between('## Pantallazo', '## Confirmación');
      expect(pantallazo).toMatch(/Un pantallazo nunca va a extracción/);
      expect(pantallazo).toMatch(/`tipo:"pantallazo"`/);
      expect(pantallazo).toMatch(/el `document_id` en el cuerpo como evidencia/);
      expect(pantallazo).toMatch(/No le pidas un PDF ni le digas al dueño que el servidor lo rechazó/);
      expect(pantallazo).toMatch(/\*\*De una factura:\*\* pídele el PDF/);
      const inventory = read('profiles/stock/skills/stock-inventario/SKILL.md');
      expect(inventory).toMatch(/solo si es una factura\. Un `pantallazo` nunca se extrae/);
      expect(inventory).toMatch(/lee la pauta con `saleads_stock_get_bet_signal` y cita su `document_id`/);
      expect(reorder()).toMatch(/Si la tarjeta trae un pantallazo, cita su `document_id` como evidencia/);
    });

    it('el servidor sigue rechazando la extracción de un pantallazo', () => {
      const documents = readFileSync(join(__dirname, '..', 'src', 'stock', 'documents.ts'), 'utf8');
      expect(documents).toMatch(/if \(row\.kind !== 'factura'\) throw invalidRequest\(\);/);
    });

    it('F-P5d (R21): «¿cómo va la pauta?» cruza pauta, ventas, salida, saldo y previsión', () => {
      const seguimiento = between('### 3. Seguimiento de la pauta (R21, R22)', '### 4. Stock repone');
      expect(seguimiento).toMatch(/no basta decir que está activa/);
      for (const field of ['`ventas_reportadas`', '`salida_inventario`', '`ritmo.actual_semanal` contra `unidades_semana_previstas`', '`alcance_pauta`']) expect(seguimiento).toContain(field);
      expect(seguimiento).toMatch(/«sin dato de gasto»/);
      expect(reorder()).toMatch(/^`SEGUIMIENTO: apuesta_id=<uuid> \|.*previstas_semana=<n> \| actual_semana=<n>.*pegando=<true\|false>/m);
      expect(reorder()).toMatch(/El gasto es opcional/);
    });

    it('F-P5d (R22): si el saldo no cubre la pauta, la baja el estratega, no Stock', () => {
      const seguimiento = between('### 3. Seguimiento de la pauta (R21, R22)', '### 4. Stock repone');
      expect(seguimiento).toMatch(/Si `alcance_pauta\.estado` es `no_alcanza`, crea una tarjeta al `estratega`/);
      expect(seguimiento).toMatch(/`unidades_semana_previstas` igual a `unidades_semana_alcanzables` y `fuente_prevision:"supuesto"`/);
      expect(reorder()).not.toMatch(/SEÑAL_BAJAR_PAUTA/);
      expect(tick()).not.toMatch(/no_alcanza, crea una propuesta apuesta nueva/);
    });
  });
  describe('1.0.4, la sesión canónica la pone el servidor (IVB-024, oficial 321e84d9, P6)', () => {
    // La real de la oficial y la que escribió Ale: difieren en 4 caracteres del último bloque.
    const REAL = 'saleads-flow-fa06b5ac-88d4-4351-bfdd-2635c1254a9b';
    const TYPO = 'saleads-flow-fa06b5ac-88d4-4351-bfdd-3255c1254a9b';
    const job = () => (JSON.parse(read('jobs.json')) as {jobs: Array<{name: string; schedule: string; prompt: string; skills: string[]}>}).jobs[0]!;
    const context = {owner_id: 'u1', business_id: 'b1', session_id: REAL, actor_role: 'ale'};

    it('el tick trae el comando notify-subscribe con el id exacto, sin marcador y sin el id mal copiado', () => {
      const prompt = scopedJobPrompt(job() as never, context as never);
      expect(prompt).not.toContain(CANONICAL_SESSION_PLACEHOLDER);
      const command = prompt.match(/hermes kanban notify-subscribe TASK_ID --platform api_server --chat-id (\S+) --notifier-profile default --delivery-mode notify\+wake/);
      expect(command?.[1]).toBe(REAL);
      expect(prompt).not.toContain(TYPO);
      // La línea de contexto y el comando dicen el mismo id.
      expect(prompt.match(/^canonical_owner_session_id=(\S+)$/m)?.[1]).toBe(command?.[1]);
    });

    it('el marcador vive en jobs.json y la skill manda copiar el comando, nunca escribir el id', () => {
      expect(job().prompt).toContain(`--chat-id ${CANONICAL_SESSION_PLACEHOLDER}`);
      expect(job().prompt).toMatch(/Nunca escribas a mano el id de la sesión/);
      expect(orchestration()).toMatch(/Usa el comando que ya trae armado el prompt de `saleads:stock-tick`, copiado tal cual y cambiando solo `TASK_ID`/);
    });

    it('un prompt sin marcador no cambia: los trabajos de 1.5.13 conservan su texto', () => {
      const plain = {name: 'x', schedule: '0 4 * * *', prompt: 'Texto {{otro}} sin sesión.', skills: []};
      expect(scopedJobPrompt(plain as never, context as never).endsWith('\nTexto {{otro}} sin sesión.')).toBe(true);
      const base = JSON.parse(readFileSync(join(__dirname, '..', 'distribution', 'saleads-sales-agent', '1.5.13', 'jobs.json'), 'utf8')) as {jobs: Array<{prompt: string}>};
      for (const item of base.jobs) expect(item.prompt).not.toContain(CANONICAL_SESSION_PLACEHOLDER);
    });
  });
  describe('1.0.4, Stock no hace marketing: ciclo estancado → marketing → validación → reposición (IVB-024, owner)', () => {
    const reorder = () => read('profiles/stock/skills/stock-reposicion/SKILL.md');
    const cycle = () => {
      const skill = orchestration();
      return skill.slice(skill.indexOf('## Ciclo con marketing'), skill.indexOf('Crear en SaleADS el producto de un kit aprobado'));
    };
    const step = (title: string, next: string) => cycle().slice(cycle().indexOf(title), cycle().indexOf(next));
    const PROFILES = join(__dirname, '..', 'distribution', 'saleads-sales-agent', '1.5.13', 'profiles');

    it('Stock solo hace stock: nunca propone pautas, promociones ni kits', () => {
      expect(reorder()).toMatch(/Nunca propones pautas, promociones ni kits: eso es de marketing/);
      expect(reorder()).toMatch(/Nunca llames `saleads_stock_propose` con `kind:"apuesta"` ni `kind:"kit"`/);
      // La barrera de rol en el servidor quedó para después de la hackathon: la skill no debe prometerla.
      expect(read('profiles/stock/SOUL.md')).not.toMatch(/el servidor los rechaza/);
      expect(reorder()).not.toMatch(/## Oferta o kit|SEÑAL_APUESTA|Calcula la previsión/);
      expect(read('profiles/stock/SOUL.md')).toMatch(/nunca propones pautas, promociones ni kits/);
      expect(read('SOUL.addendum.md')).toMatch(/Las pautas, los kits y las promociones son de marketing/);
    });

    it('1. estancado con saldo y costo: Stock pregunta si se lo pasa a marketing, y solo con el sí va al investigador', () => {
      expect(orchestration()).toMatch(/Un aviso de `avisos_pendientes` con `siguiente:"marketing"` \(`frenazo`, `lento` o `sin_pauta`\) trae la pregunta del servidor: «… ¿Se lo paso a marketing para que lo mueva\?»/);
      expect(orchestration()).toMatch(/`cifras\.dias_sin_venta` del aviso/);
      const uno = step('### 1. Producto estancado', '### 2. Marketing');
      expect(uno).toMatch(/Solo con el sí del dueño a esa pregunta sigues/);
      expect(uno).toMatch(/asignado `investigador`, `skills:\["saleads-market-research","saleads-offer-kit"\]`/);
      for (const field of ['saldo', 'costo y moneda', 'días sin venta', 'ritmo base y actual', 'los productos que sí rotan para combinar']) expect(uno).toContain(field);
      expect(uno).toMatch(/avatar, propuesta de valor y si conviene una pauta, un kit o una promoción/);
    });

    it('2. el estratega arma la pauta con previsión, Stock la valida y Ale crea la propuesta', () => {
      const dos = step('### 2. Marketing', '### 3. Seguimiento');
      expect(dos).toMatch(/tarjeta al `estratega` con `skills:\["saleads-type-physical-product"\]`/);
      expect(dos).toMatch(/`unidades_semana_previstas` con `fuente_prevision` `dato` o `supuesto`/);
      expect(dos.indexOf('**Validación de Stock**')).toBeGreaterThan(dos.indexOf('`estratega`'));
      expect(dos.indexOf('Tú creas la propuesta')).toBeGreaterThan(dos.indexOf('**Validación de Stock**'));
      expect(dos).toMatch(/`unidades_semana_previstas` y `fuente_prevision` del estratega, nunca `null`/);
      expect(reorder()).toMatch(/^`VALIDACION: variante_id=<uuid> \|.*\| <alcanza\|no_alcanza> \|/m);
      expect(reorder()).toMatch(/No cambies la previsión ni el presupuesto de marketing/);
    });

    it('3. producto volando: `pegando` llega como aviso del servidor y, con el sí, Ale crea la tarjeta a Stock para reponer', () => {
      const tres = step('### 3. Seguimiento', '### 4. Stock repone');
      expect(tres).toMatch(/Si la señal trae `pegando:true`, el servidor lo pone en `avisos_pendientes` como aviso `pegando`, con `siguiente:"pedido"`/);
      expect(tick()).toMatch(/Si pega, llega como aviso pegando \(punto 6\)/);
      expect(orchestration()).toMatch(/no crees la tarjeta de reposición antes del sí del dueño/);
      expect(reorder()).toMatch(/Si la señal trae `pegando:true`, el ritmo nuevo es `ritmo_actual_semana`/);
    });

    it('4. Stock decide el pedido con la previsión (R24) y pregunta «¿Llamo al proveedor?»; Ale no lo propone', () => {
      expect(reorder()).toMatch(/La cantidad sale de la pauta vigente y su previsión \(R24\)/);
      expect(reorder()).toMatch(/Con eso Ale le pregunta al dueño «¿Llamo al proveedor\?»/);
      expect(orchestration()).toMatch(/Un aviso con `siguiente:"pedido"` \(`cobertura` o `pegando`\) pregunta «¿Le pido a Stock que prepare el pedido\?»\. Con el sí del dueño a esa pregunta, crea una tarjeta a Stock/);
      expect(orchestration()).toMatch(/dile al dueño en una frase la cantidad, el proveedor y «¿Llamo al proveedor\?», con `saleads_stock_robot_say` de texto libre/);
      expect(reorder()).toMatch(/El dueño puede cambiarlo en pantalla, y no hace falta preguntárselo/);
      const cuatro = cycle().slice(cycle().indexOf('### 4. Stock repone'));
      expect(cuatro).toMatch(/nunca llames `saleads_stock_propose` con `kind:"pedido"`/);
      expect(cuatro).toMatch(/Nunca le pidas el mandato tú/);
      expect(tick()).toMatch(/tú nunca propones el pedido/);
    });

    it('5. vocabulario con el dueño: pauta, producto, kit, promoción, precio; nunca «oferta» sola', () => {
      expect(orchestration()).toMatch(/### Vocabulario/);
      expect(orchestration()).toMatch(/Nunca digas «oferta» sola/);
      expect(read('SOUL.addendum.md')).toMatch(/Nunca «oferta» sola/);
      expect(reorder()).toMatch(/Nunca «oferta» sola/);
      // Ninguna frase entre comillas que vaya al dueño dice «oferta».
      for (const file of ['skills/saleads-stock-orchestration/SKILL.md', 'profiles/stock/skills/stock-reposicion/SKILL.md', 'SOUL.addendum.md']) {
        for (const quote of read(file).match(/«[^»]*»/g) ?? []) if (quote !== '«oferta»') expect(quote).not.toMatch(/\boferta\b/i);
      }
    });

    it('F-P8a (R32): «llegó el pedido» con un pedido acordado es recepción de Stock, con order_id y contra lo pedido', () => {
      const cuatro = cycle().slice(cycle().indexOf('### 4. Stock repone'));
      expect(cuatro).toMatch(/Si hay un pedido `acordado` de esa variante, crea la tarjeta `pedido` a Stock con su `order_id`/);
      expect(cuatro).toMatch(/compara contra lo pedido, no contra el libro: no preguntes «¿venta, fiado…\?»/);
      expect(cuatro).toMatch(/Después del conteo, pide la factura de ese pedido/);
      expect(cuatro).toMatch(/Nunca llames `saleads_stock_propose` con `conteo`, `pedido`, `entrada`, `venta` ni `catalogo`/);
      const inventory = read('profiles/stock/skills/stock-inventario/SKILL.md');
      expect(inventory).toMatch(/Si hay un pedido `acordado` de esa variante, es una recepción \(R32\)/);
      expect(inventory.indexOf('es una recepción (R32)')).toBeLessThan(inventory.indexOf('## Factura'));
      expect(reorder()).toMatch(/Si la tarjeta no trae el `order_id`, búscalo en `saleads_stock_list_orders`/);
      expect(reorder()).toMatch(/Nunca lo propongas como conteo contra el libro/);
      expect(reorder()).toMatch(/«falta la factura del pedido»: Ale la pide/);
    });

    it('F-P8c (R31): la entrada de la factura de un pedido acordado y contado lleva su order_id', () => {
      const recepcion = reorder().slice(reorder().indexOf('## Recepción'), reorder().indexOf('## Permiso'));
      expect(recepcion).toMatch(/2\. Propón `entrada` con `order_id` y la factura \(R31\)/);
      expect(recepcion).toMatch(/la entrada lleva ese `order_id` aunque la tarjeta sea `factura` y no lo traiga: búscalo en `saleads_stock_list_orders`/);
      expect(recepcion).toMatch(/Sin `order_id` el pedido no pasa a recibido y el ahorro no se confirma/);
      const inventory = read('profiles/stock/skills/stock-inventario/SKILL.md');
      expect(inventory).toMatch(/si hay un pedido `acordado` de ese proveedor con su recepción ya contada, agrega su `order_id`/);
    });

    it('cierre de la oficial (P9): Ale lee el estado real antes de hablar, nunca lo que recuerda del objetivo', () => {
      expect(orchestration()).toMatch(/## Estado real antes de hablar/);
      expect(orchestration()).toMatch(/Nunca uses lo que recuerdes del objetivo \(GoalState\)/);
      expect(orchestration()).toMatch(/Si lo que recuerdas no coincide con las herramientas, mandan las herramientas/);
      expect(tick()).toMatch(/Lee saleads_stock_get_overview, saleads_stock_list_proposals .* y saleads_stock_list_orders\. El estado de pautas, kits, pedidos, facturas y permisos sale de este turno, nunca de lo que recuerdes del objetivo/);
      expect(read('SOUL.addendum.md')).toMatch(/estado de pautas, kits, pedidos, facturas y permisos salen de las herramientas del turno en curso/);
    });

    it('P9 (R34): pedir nivel 3 depende del ahorro confirmado, y por eso de la entrada con order_id (F-P8c)', () => {
      const permiso = reorder().slice(reorder().indexOf('## Permiso'));
      expect(permiso).toMatch(/sin un pedido `recibido`, completo y con ahorro mayor a 0, responde 409/);
      expect(permiso).toMatch(/la entrada de la factura tuvo que llevar el `order_id` del pedido \(Recepción, punto 2\)/);
      // La condición del servidor es esa misma: pedido recibido, completo y con ahorro confirmado.
      const autonomy = readFileSync(join(__dirname, '..', 'src', 'stock', 'autonomy.ts'), 'utf8');
      expect(autonomy).toMatch(/o\.status = 'recibido' AND o\.received_qty = o\.quantity AND o\.saving_confirmed > 0/);
    });

    it('R29 (paso 7): con el proveedor, Stock se presenta con el nombre del negocio', () => {
      expect(read('profiles/stock/skills/stock-negociacion/SKILL.md')).toMatch(/con el nombre del negocio \(R29\), el de `saleads_get_business_profile`/);
      expect(read('profiles/stock/skills/stock-negociacion/SKILL.md')).toMatch(/Nunca «del negocio» a secas/);
    });

    it('los perfiles de marketing que usa el ciclo existen en el bundle 1.5.13', () => {
      for (const profile of ['investigador', 'estratega']) expect(readFileSync(join(PROFILES, profile, 'SOUL.md'), 'utf8').length).toBeGreaterThan(0);
      const type = join(__dirname, '..', 'distribution', 'saleads-sales-agent', '1.5.13', 'skills', 'types', 'physical_product', 'saleads-type-physical-product', 'SKILL.md');
      expect(readFileSync(type, 'utf8')).toMatch(/^name: saleads-type-physical-product$/m);
      expect(read('profiles/investigador/skills/saleads-offer-kit/SKILL.md')).toMatch(/^name: saleads-offer-kit$/m);
    });
  });
  describe('1.0.5, el prompt cabe en Hermes (IVB-024, simulación sesión 4)', () => {
    // Hermes rechazó el de 1.0.4 con 400 «Prompt must be ≤ 5000 characters»: 4.456 de jobs.json más el encabezado dieron 5.696.
    const SESSION = 'saleads-flow-fa06b5ac-88d4-4351-bfdd-2635c1254a9b';
    const context = {owner_id: 'b7a9f0c2-1d3e-4f5a-8b6c-7d8e9f0a1b2c', business_id: 'a6b8e93d-0f1e-4d2c-9b3a-8c7d6e5f4a3b', session_id: SESSION, actor_role: 'ale'};
    const jobs = () => (JSON.parse(read('jobs.json')) as {jobs: Array<{name: string; schedule: string; prompt: string; skills: string[]}>}).jobs;

    it('cada trabajo del complemento, ya con encabezado y sesión real, queda en 4.500 caracteres o menos (Hermes acepta 5.000)', () => {
      expect(jobs().length).toBeGreaterThan(0);
      for (const job of jobs()) {
        const text = scopedJobPrompt(job as never, context as never);
        expect(text).toContain(SESSION);
        expect(text.length).toBeLessThanOrEqual(4500);
      }
    });

    it('la prueba de largo atrapa el texto de 1.0.4', () => {
      const old = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'stock-tick-1.0.4.json'), 'utf8')) as {name: string; schedule: string; prompt: string; skills: string[]};
      expect(scopedJobPrompt(old as never, context as never).length).toBeGreaterThan(5000);
    });

    it('la regla AVISO llama robot_say dentro del turno: la respuesta final no basta', () => {
      expect(tick()).toMatch(/Escribirlos en tu respuesta final no los dice: esa respuesta va al canal del dueño y puede no llegar/);
      expect(orchestration()).toMatch(/Llámalo en ese mismo turno, antes de terminar\. Escribir el aviso en tu respuesta final no lo dice/);
    });
  });
  describe('1.0.6, el ciclo de marketing vuelve a la voz y termina en propuestas (IVB-024, prueba corta 9bb83a2b, P4)', () => {
    const cycle = () => {
      const skill = orchestration();
      return skill.slice(skill.indexOf('### 2. Marketing'), skill.indexOf('### 3. Seguimiento'));
    };

    it('F-C4d: las tarjetas del ciclo llevan origen voz y su resultado vuelve con robot_say, además del chat', () => {
      const skill = orchestration();
      expect(skill).toMatch(/\*\*El ciclo con marketing también vuelve a la voz\.\*\* Si nace de un aviso de Stock o de un turno de voz, cada tarjeta que crees en él \(investigador, estratega, validación de Stock\) lleva `origen: voz`/);
      expect(skill).toMatch(/dile el resultado con `saleads_stock_robot_say` además de en el chat: una frase con cifras, `pregunta:false`, `prioridad:"normal"`/);
      expect(skill).toMatch(/`dedupe_key` `stock-ciclo:<tarjeta>`/);
      expect(read('SOUL.addendum.md')).toMatch(/lo mismo el resultado de marketing cuando el ciclo nació de un aviso de Stock o de la voz/);
    });

    it('la recomendación del estratega se vuelve propuesta (kit con margen del servidor o pauta con previsión), validada con Stock', () => {
      const dos = cycle();
      expect(dos).toMatch(/La recomendación del estratega se vuelve propuesta, no pregunta/);
      expect(dos).toMatch(/No le hagas preguntas abiertas sobre qué hacer/);
      expect(dos).toMatch(/Pauta sola con margen negativo, o que el estratega no recomienda: no la propongas\. Si recomienda kits, propón esos kits/);
      expect(dos).toMatch(/para un kit, saldo y costo de cada componente/);
      expect(dos).toMatch(/El margen lo calcula el servidor \(R20d\)/);
      expect(dos.indexOf('**Validación de Stock**')).toBeLessThan(dos.indexOf('Tú creas la propuesta'));
      expect(read('profiles/stock/skills/stock-reposicion/SKILL.md')).toMatch(/Para un kit, una línea por componente: `VALIDACION: variante_id=<uuid> \| saldo=<n> \| costo=<valor o sin_dato>/);
    });

    it('en voz una frase «Marketing propone …; está en pantalla para aprobar», y solo pregunta lo que falta, concreto', () => {
      const dos = cycle();
      expect(dos).toMatch(/«Marketing propone <pauta o kit, con precio o presupuesto y margen del servidor>; está en pantalla para aprobar»/);
      expect(dos).toMatch(/Solo preguntas si falta un dato que el servidor no tiene, y lo dices concreto/);
      expect(dos).toMatch(/«¿A qué precio vendes el kit <nombre>\?»/);
    });
  });

  describe('1.0.8, la tarjeta de mover se liga al aviso y una vieja no cuenta (IVB-024, prueba corta 493de588, P4)', () => {
    it('la clave lleva el alerta_id del aviso y solo esa clave cuenta como ya pasado', () => {
      const text = orchestration();
      expect(text).toContain('clave `stock:<business_id>:mover:<alerta_id>`');
      expect(text).not.toContain('mover:<variante_id>:<AAAAMMDD>');
      expect(text).toMatch(/Solo cuenta como «ya pasado a marketing» una tarjeta con esa clave exacta/);
      expect(text).toMatch(/Nunca digas «ya está pasado» ni «no lo duplico» sin haber visto esa clave en `kanban_list`/);
    });

    it('F-R4b y F-C4d: con alcanza propone aunque sea simulado, y el resultado vuelve a la voz', () => {
      const text = orchestration();
      expect(text).toMatch(/Que los datos sean simulados no frena nada/);
      expect(text).toMatch(/Nunca esperes un conteo fresco ni una factura real para proponer/);
      expect(text).toMatch(/aunque Jolly esté dormido: queda en cola\. El chat solo no basta/);
      expect(read('profiles/stock/skills/stock-reposicion/SKILL.md')).toMatch(/No condiciones la validación a un conteo fresco ni a una factura real/);
    });
  });
});
