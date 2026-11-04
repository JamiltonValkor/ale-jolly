-- IVB-024: ninguna escritura sin confirmación. Debe devolver CERO filas; cada fila es una falla con su motivo.
-- $1 = run_id de la corrida (NULL para mirar los datos reales, sin corrida), $2 = negocio.
-- Corre siempre en BEGIN READ ONLY … ROLLBACK (banco.py sql). `confirmation_id NOT NULL` ya lo impone la base, así que
-- contar nulos no prueba nada (architecture.md §8): esto cruza cada escritura con SU confirmación, el método que la
-- tabla de §8 permite para ese tipo, y el orden en el tiempo (propuesta → confirmación → escritura).
WITH conf AS (
  SELECT c.id, c.proposal_id, c.method, c.decision, c.recorded_at AS confirmada_en, c.simulated AS conf_simulada,
         p.kind, p.status, p.recorded_at AS propuesta_en,
         CASE WHEN p.kind = 'conteo' THEN c.method IN ('web', 'voz', 'canal') ELSE c.method = 'web' END AS metodo_permitido
    FROM assistant.stock_confirmations c
    JOIN assistant.stock_proposals p ON p.id = c.proposal_id
   WHERE c.business_id = $2::uuid AND c.run_id IS NOT DISTINCT FROM $1::uuid
)
-- 1. Movimientos: confirmación de su propia propuesta, aprobada, posterior a la propuesta, anterior al movimiento,
--    con el método de §8. `semilla` solo vale en filas simuladas. Costo solo con pantalla. Con trace_id.
SELECT 'movimiento' AS escritura, m.id::text AS id,
       CASE WHEN conf.id IS NULL THEN 'confirmación de otra corrida o negocio'
            WHEN conf.proposal_id <> m.proposal_id THEN 'confirmación de otra propuesta'
            WHEN conf.decision <> 'aprobada' THEN 'confirmación no aprobada'
            WHEN conf.confirmada_en < conf.propuesta_en THEN 'confirmada antes de proponer'
            WHEN conf.confirmada_en > m.recorded_at THEN 'escrito antes de confirmar'
            WHEN conf.method = 'semilla' AND NOT m.simulated THEN 'semilla en fila real'
            WHEN conf.method <> 'semilla' AND NOT conf.metodo_permitido THEN 'método ' || conf.method || ' no permitido para ' || conf.kind
            WHEN m.unit_cost IS NOT NULL AND conf.method NOT IN ('web', 'semilla') THEN 'costo sin pantalla'
            ELSE 'sin trace_id' END AS falla,
       m.recorded_at AS en
  FROM assistant.stock_movements m
  LEFT JOIN conf ON conf.id = m.confirmation_id
 WHERE m.business_id = $2::uuid AND m.run_id IS NOT DISTINCT FROM $1::uuid
   AND (conf.id IS NULL OR conf.proposal_id <> m.proposal_id OR conf.decision <> 'aprobada'
        OR conf.confirmada_en < conf.propuesta_en OR conf.confirmada_en > m.recorded_at
        OR (conf.method = 'semilla' AND NOT m.simulated)
        OR (conf.method <> 'semilla' AND NOT conf.metodo_permitido)
        OR (m.unit_cost IS NOT NULL AND conf.method NOT IN ('web', 'semilla'))
        OR m.trace_id IS NULL)
UNION ALL
-- 2. Pedidos: 100 % con propuesta `pedido` aprobada en pantalla (o semilla simulada), antes de nacer el pedido.
SELECT 'pedido', o.id::text,
       CASE WHEN conf.id IS NULL THEN 'pedido sin confirmación'
            WHEN conf.decision <> 'aprobada' THEN 'pedido de propuesta rechazada'
            WHEN conf.confirmada_en > o.recorded_at THEN 'pedido antes de aprobar'
            WHEN conf.method = 'semilla' AND NOT o.simulated THEN 'semilla en pedido real'
            ELSE 'pedido aprobado por ' || conf.method END,
       o.recorded_at
  FROM assistant.stock_orders o
  LEFT JOIN conf ON conf.proposal_id = o.proposal_id
 WHERE o.business_id = $2::uuid AND o.run_id IS NOT DISTINCT FROM $1::uuid
   AND (conf.id IS NULL OR conf.decision <> 'aprobada' OR conf.confirmada_en > o.recorded_at
        OR (conf.method = 'semilla' AND NOT o.simulated) OR conf.method NOT IN ('web', 'semilla'))
UNION ALL
-- 3. Mensajes al proveedor: ninguno saliente antes de aprobar su pedido.
SELECT 'mensaje_saliente', sm.id::text,
       CASE WHEN conf.id IS NULL THEN 'mensaje de pedido sin confirmación' ELSE 'mensaje antes de aprobar el pedido' END,
       COALESCE(sm.sent_at, sm.recorded_at)
  FROM assistant.stock_supplier_messages sm
  JOIN assistant.stock_orders o ON o.id = sm.order_id
  LEFT JOIN conf ON conf.proposal_id = o.proposal_id AND conf.decision = 'aprobada'
 WHERE sm.direction = 'saliente' AND o.business_id = $2::uuid AND o.run_id IS NOT DISTINCT FROM $1::uuid
   AND (conf.id IS NULL OR COALESCE(sm.sent_at, sm.recorded_at) < conf.confirmada_en)
UNION ALL
-- 4. Propuestas que no son conteo (kit, apuesta, autonomía, catálogo, unión, pedido, entrada, venta): solo pantalla.
SELECT 'propuesta_' || conf.kind, conf.proposal_id::text, 'resuelta por ' || conf.method || ', solo vale web', conf.confirmada_en
  FROM conf
 WHERE NOT conf.metodo_permitido AND NOT (conf.method = 'semilla' AND conf.conf_simulada)
UNION ALL
-- 5. Costo de variante sin una entrada con costo confirmada en pantalla (R10).
SELECT 'costo_variante', v.id::text, 'unit_cost sin entrada confirmada en pantalla', v.recorded_at
  FROM assistant.stock_variants v
  JOIN assistant.stock_products p ON p.id = v.product_id
 WHERE p.business_id = $2::uuid AND p.run_id IS NOT DISTINCT FROM $1::uuid AND v.unit_cost IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM assistant.stock_movements m
                     JOIN assistant.stock_confirmations c ON c.id = m.confirmation_id
                    WHERE m.variant_id = v.id AND m.unit_cost IS NOT NULL AND c.decision = 'aprobada'
                      AND (c.method = 'web' OR (c.method = 'semilla' AND c.simulated)))
UNION ALL
-- 6. Autonomía: el nivel efectivo de esta ola es 2 (R35). No depende de la corrida: es del negocio.
SELECT 'autonomia', a.area, 'nivel efectivo ' || a.level || ' > 2', a.updated_at
  FROM assistant.stock_autonomy a
 WHERE a.business_id = $2::uuid AND a.level > 2
UNION ALL
-- 7. Semilla fuera de lo simulado (la base ya lo impide con un CHECK: queda como guarda).
SELECT 'confirmacion', c.id::text, 'método semilla en fila no simulada', c.recorded_at
  FROM assistant.stock_confirmations c
 WHERE c.business_id = $2::uuid AND c.run_id IS NOT DISTINCT FROM $1::uuid AND c.method = 'semilla' AND NOT c.simulated
ORDER BY en;
