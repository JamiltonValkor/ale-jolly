'use client'

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { PAIRING_TIMINGS, robotPollInterval } from '../lib/pairing-transport'
import {
  initialRobotModel,
  robotReducer,
  type RobotEvent,
  type RobotModel,
} from '../lib/robot-screen-machine'
import { companionKeys } from './use-companion-queries'
import { usePairingTransport } from './use-pairing-transport'

type Timings = typeof PAIRING_TIMINGS

interface Options {
  /** Identificador del robot, si su software lo pasa (`?device=`). */
  deviceId?: string
  timings?: Partial<Timings>
}

export interface RobotPairing {
  model: RobotModel
  /** Milisegundos que le quedan al código (solo mientras se muestra). */
  remainingMs: number | null
  /** Segundos para el siguiente reintento sin conexión. */
  retryInSeconds: number | null
  retryNow: () => void
}

/** Arranque mínimo, saludo y renovación del código vencido. */
function useScreenTimers(
  model: RobotModel,
  dispatch: Dispatch<RobotEvent>,
  t: Timings,
  renew: () => void
) {
  useEffect(() => {
    if (model.screen !== 'boot' || model.bootDone) return
    const timer = setTimeout(() => dispatch({ type: 'BOOT_DONE' }), t.bootMinMs)
    return () => clearTimeout(timer)
  }, [model.screen, model.bootDone, dispatch, t.bootMinMs])

  useEffect(() => {
    if (model.screen !== 'paired') return
    const timer = setTimeout(
      () => dispatch({ type: 'PAIRED_SHOWN' }),
      t.pairedHoldMs
    )
    return () => clearTimeout(timer)
  }, [model.screen, dispatch, t.pairedHoldMs])

  useEffect(() => {
    if (model.screen !== 'expired') return
    const timer = setTimeout(renew, t.renewDelayMs)
    return () => clearTimeout(timer)
  }, [model.screen, renew, t.renewDelayMs])
}

/** Cuenta lo que le queda al código y avisa cuando vence por reloj. */
function useCodeClock(
  model: RobotModel,
  dispatch: Dispatch<RobotEvent>
): number | null {
  const [now, setNow] = useState(() => Date.now())
  const expiresAt = model.session ? Date.parse(model.session.expires_at) : null
  const showing = model.screen === 'pairing' && expiresAt !== null
  useEffect(() => {
    if (!showing) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [showing])
  const remaining =
    showing && expiresAt !== null ? Math.max(0, expiresAt - now) : null
  useEffect(() => {
    if (remaining === 0) dispatch({ type: 'CODE_EXPIRED' })
  }, [remaining, dispatch])
  return remaining
}

/** Sin conexión: reintenta solo cada N segundos (y al volver el wifi). */
function useOfflineRetry(
  model: RobotModel,
  retry: () => void,
  everyMs: number
): number | null {
  const total = Math.max(1, Math.round(everyMs / 1000))
  const [left, setLeft] = useState(total)
  const offline = model.screen === 'offline'
  useEffect(() => {
    if (!offline) return
    setLeft(total)
    const tick = setInterval(() => {
      setLeft(current => {
        if (current > 1) return current - 1
        retry()
        return total
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [offline, retry, total])
  useEffect(() => {
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [retry])
  return offline ? left : null
}

/**
 * Lo que ve la pantalla del robot: crea su código, lo consulta, y pasa por
 * sincronizando → saludo → en vivo; renueva el código vencido solo y se
 * recupera sin ayuda cuando vuelve la conexión.
 */
export function useRobotPairing({
  deviceId,
  timings,
}: Options = {}): RobotPairing {
  const t: Timings = { ...PAIRING_TIMINGS, ...timings }
  const transport = usePairingTransport()
  const [model, dispatch] = useReducer(robotReducer, initialRobotModel)
  const creating = useRef(false)

  const create = useMutation({
    mutationFn: () =>
      transport.createPairing(deviceId ? { deviceId } : undefined),
    onSuccess: session => dispatch({ type: 'SESSION_CREATED', session }),
    onError: () => dispatch({ type: 'REQUEST_FAILED' }),
    onSettled: () => {
      creating.current = false
    },
  })
  const { mutate } = create
  const requestSession = useCallback(() => {
    if (creating.current) return
    creating.current = true
    mutate()
  }, [mutate])

  const session = model.session
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  const interval = robotPollInterval(model.screen, transport.kind)
  // La clave lleva discriminadores estables: `kind` (un transporte por app) y
  // `pairing_id` (identifica la sesión), no los objetos.
  const getStatus = useCallback(() => {
    if (!session) throw new Error('sin código')
    return transport.getPairingStatus(session)
  }, [transport, session])
  const status = useQuery({
    queryKey: companionKeys.robot(transport.kind, session?.pairing_id ?? null),
    queryFn: getStatus,
    enabled: Boolean(session) && interval !== false,
    refetchInterval: interval,
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  const { refetch } = status

  useEffect(() => {
    if (status.data) dispatch({ type: 'STATUS', status: status.data })
  }, [status.data, status.dataUpdatedAt])
  useEffect(() => {
    if (status.errorUpdatedAt) dispatch({ type: 'REQUEST_FAILED' })
  }, [status.errorUpdatedAt])

  useEffect(() => {
    if (model.screen === 'boot' && !session && model.failures === 0)
      requestSession()
  }, [model.screen, session, model.failures, requestSession])

  useEffect(() => {
    const lost = () => dispatch({ type: 'CONNECTION_LOST' })
    window.addEventListener('offline', lost)
    const off = transport.subscribe?.(signal => {
      if (signal === 'changed' && sessionRef.current) void refetch()
    })
    return () => {
      window.removeEventListener('offline', lost)
      off?.()
    }
  }, [transport, refetch])

  const retry = useCallback(() => {
    if (session) void refetch()
    else requestSession()
  }, [session, refetch, requestSession])

  useScreenTimers(model, dispatch, t, requestSession)
  const remainingMs = useCodeClock(model, dispatch)
  const retryInSeconds = useOfflineRetry(model, retry, t.offlineRetryMs)

  return { model, remainingMs, retryInSeconds, retryNow: retry }
}
