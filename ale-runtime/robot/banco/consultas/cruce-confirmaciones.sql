-- IVB-024: cada escritura de la corrida con su confirmación, para cruzarla a mano con bitacora-humana.md.
-- $1 = run_id (NULL sin corrida), $2 = negocio. Solo lectura. Las filas de método `semilla` son la historia simulada.
-- Por fila: qué se escribió, cuándo, qué propuesta lo autorizó, por qué vía, quién y cuándo. El operador busca en la
-- bitácora la puerta humana con esa hora (± 2 min) y esa vía; una fila sin puerta humana es una falla del paso.
WITH conf AS (
  SELECT c.id, c.proposal_id, c.method, c.decision, c.actor, c.channel, c.utterance_id, c.quote IS NOT NULL AS con_cita,
         c.recorded_at AS confirmada_en, c.simulated, p.kind, p.status, p.recorded_at AS propuesta_en, p.trace_id
    FROM assistant.stock_confirmations c
    JOIN assistant.stock_proposals p ON p.id = c.proposal_id
   WHERE c.business_id = $2::uuid AND c.run_id IS NOT DISTINCT FROM $1::uuid
)
SELECT 'movimiento' AS escritura, m.id::text AS id, m.kind AS detalle, m.delta AS cantidad, m.unit_cost AS costo,
       m.recorded_at AS escrita_en, m.simulated, m.trace_id::text AS trace_id,
       conf.kind AS propuesta, conf.proposal_id::text AS propuesta_id, conf.method, conf.decision, conf.actor,
       conf.utterance_id IS NOT NULL AS con_frase, conf.con_cita, conf.propuesta_en, conf.confirmada_en
  FROM assistant.stock_movements m
  LEFT JOIN conf ON conf.id = m.confirmation_id
 WHERE m.business_id = $2::uuid AND m.run_id IS NOT DISTINCT FROM $1::uuid
UNION ALL
SELECT 'pedido', o.id::text, o.status, o.quantity, o.agreed_cost, o.recorded_at, o.simulated, NULL,
       conf.kind, conf.proposal_id::text, conf.method, conf.decision, conf.actor, conf.utterance_id IS NOT NULL, conf.con_cita,
       conf.propuesta_en, conf.confirmada_en
  FROM assistant.stock_orders o
  LEFT JOIN conf ON conf.proposal_id = o.proposal_id
 WHERE o.business_id = $2::uuid AND o.run_id IS NOT DISTINCT FROM $1::uuid
UNION ALL
SELECT 'mensaje_saliente', sm.id::text, CASE WHEN sm.blocked_reason IS NULL THEN 'enviado' ELSE 'bloqueado: ' || sm.blocked_reason END,
       NULL, NULL, COALESCE(sm.sent_at, sm.recorded_at), o.simulated, NULL,
       conf.kind, conf.proposal_id::text, conf.method, conf.decision, conf.actor, conf.utterance_id IS NOT NULL, conf.con_cita,
       conf.propuesta_en, conf.confirmada_en
  FROM assistant.stock_supplier_messages sm
  JOIN assistant.stock_orders o ON o.id = sm.order_id
  LEFT JOIN conf ON conf.proposal_id = o.proposal_id
 WHERE sm.direction = 'saliente' AND o.business_id = $2::uuid AND o.run_id IS NOT DISTINCT FROM $1::uuid
UNION ALL
-- Kit, apuesta, autonomía y catálogo no escriben movimientos: su escritura es la propuesta resuelta.
SELECT 'propuesta', conf.proposal_id::text, conf.kind || ' ' || conf.status, NULL, NULL, conf.confirmada_en, conf.simulated,
       conf.trace_id::text, conf.kind, conf.proposal_id::text, conf.method, conf.decision, conf.actor,
       conf.utterance_id IS NOT NULL, conf.con_cita, conf.propuesta_en, conf.confirmada_en
  FROM conf
 WHERE conf.kind IN ('kit', 'apuesta', 'autonomia', 'catalogo', 'union_catalogo')
ORDER BY escrita_en;
