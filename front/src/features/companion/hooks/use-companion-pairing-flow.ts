'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
} from 'react'

import {
  hasForbiddenCharacters,
  isValidPairingCode,
  normalizePairingCode,
} from '../lib/pairing-code'
import { toFlowError, toPairingErrorCode } from '../lib/pairing-error'
import {
  flowReducer,
  initialFlowModel,
  type FlowEvent,
  type FlowModel,
} from '../lib/pairing-flow-machine'
import { PAIRING_TIMINGS } from '../lib/pairing-transport'
import type { CompanionDevice, SyncStep } from '../types/pairing.schemas'
import {
  useClaimCompanionMutation,
  useCompanionStatus,
  useTransportSignals,
  useUnpairCompanionMutation,
} from './use-companion-queries'
import { usePairingTransport } from './use-pairing-transport'

export interface PairingBusiness {
  id: string
  name: string
}

interface Options {
  /** Código que llega del QR (`?pair=`). */
  initialCode?: string | null
  businesses: readonly PairingBusiness[]
  selectedBusinessId?: string | null
}

export interface PairingFlowActions {
  start: () => void
  changeCode: (raw: string) => void
  submitCode: () => void
  chooseBusiness: (id: string) => void
  back: () => void
  retry: () => void
  tryHello: () => void
  askUnpair: () => void
  cancelUnpair: () => void
  confirmUnpair: () => void
  pairAgain: () => void
}

export interface PairingFlow {
  model: FlowModel
  needsBusiness: boolean
  business: PairingBusiness | null
  syncStep: SyncStep | null
  syncSlow: boolean
  device: CompanionDevice | null
  claiming: boolean
  unpairing: boolean
  unpairFailed: boolean
  forbiddenTyped: boolean
  /** Veces que tocó «Probar: dile hola». */
  helloNonce: number
  actions: PairingFlowActions
}

/** Avisa «tarda más de lo normal» si la sincronización se alarga. */
function useSyncSlow(syncing: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!syncing) {
      setSlow(false)
      return
    }
    const timer = setTimeout(
      () => setSlow(true),
      PAIRING_TIMINGS.syncSlowAfterMs
    )
    return () => clearTimeout(timer)
  }, [syncing])
  return slow
}

interface ActionDeps {
  model: FlowModel
  dispatch: Dispatch<FlowEvent>
  needsBusiness: boolean
  runClaim: (code: string, businessId: string | null) => void
  sayHello: () => void
  unpair: (
    input: undefined,
    callbacks: { onSuccess: () => void; onError: () => void }
  ) => void
  setForbiddenTyped: (value: boolean) => void
  setUnpairFailed: (value: boolean) => void
}

/** Acciones del flujo: lo que la vista dispara, ya traducido a eventos y llamadas. */
function useFlowActions(deps: ActionDeps): PairingFlowActions {
  const { model, dispatch, needsBusiness, runClaim, sayHello, unpair } = deps
  const { setForbiddenTyped, setUnpairFailed } = deps
  return useMemo<PairingFlowActions>(
    () => ({
      start: () => dispatch({ type: 'START' }),
      changeCode: raw => {
        setForbiddenTyped(hasForbiddenCharacters(raw))
        dispatch({ type: 'CODE_CHANGED', code: normalizePairingCode(raw) })
      },
      submitCode: () => {
        if (!isValidPairingCode(model.code)) return
        if (needsBusiness && model.step === 'connect') {
          dispatch({ type: 'CODE_SUBMITTED', needsBusiness: true })
        } else runClaim(model.code, model.businessId)
      },
      chooseBusiness: id =>
        dispatch({ type: 'BUSINESS_CHOSEN', businessId: id }),
      back: () => dispatch({ type: 'BACK' }),
      retry: () => {
        const again =
          model.error === 'DEVICE_OFFLINE' || model.error === 'NETWORK'
        dispatch({ type: 'RETRY' })
        if (again) runClaim(model.code, model.businessId)
      },
      tryHello: () => {
        dispatch({ type: 'TRY_HELLO' })
        sayHello()
      },
      askUnpair: () => {
        setUnpairFailed(false)
        dispatch({ type: 'ASK_UNPAIR' })
      },
      cancelUnpair: () => dispatch({ type: 'CANCEL_UNPAIR' }),
      confirmUnpair: () =>
        unpair(undefined, {
          onSuccess: () => dispatch({ type: 'UNPAIRED' }),
          onError: () => setUnpairFailed(true),
        }),
      pairAgain: () => dispatch({ type: 'PAIR_AGAIN' }),
    }),
    [
      model,
      dispatch,
      needsBusiness,
      runClaim,
      sayHello,
      unpair,
      setForbiddenTyped,
      setUnpairFailed,
    ]
  )
}

/**
 * Contenedor de la sincronización del lado de Saleads: estado del flujo,
 * reclamo del código, progreso real y desvincular.
 */
export function useCompanionPairingFlow(options: Options): PairingFlow {
  const { businesses } = options
  const transport = usePairingTransport()
  const [model, dispatch] = useReducer(
    flowReducer,
    {
      initialCode: options.initialCode,
      businessId: options.selectedBusinessId ?? businesses[0]?.id ?? null,
    },
    initialFlowModel
  )
  const [forbiddenTyped, setForbiddenTyped] = useState(false)
  const [unpairFailed, setUnpairFailed] = useState(false)
  const status = useCompanionStatus({ syncing: model.step === 'syncing' })
  useTransportSignals()
  const claim = useClaimCompanionMutation()
  const unpair = useUnpairCompanionMutation()
  const syncSlow = useSyncSlow(model.step === 'syncing')
  const paired = status.data?.paired === true

  useEffect(() => {
    if (paired) dispatch({ type: 'DEVICE_FOUND' })
    if (paired) dispatch({ type: 'SYNC_COMPLETED' })
  }, [paired])

  const { mutate: claimMutate } = claim
  const runClaim = useCallback(
    (code: string, businessId: string | null) => {
      claimMutate(
        businessId ? { code, business_id: businessId } : { code },
        {
          onSuccess: result =>
            dispatch({ type: 'CLAIM_SUCCEEDED', status: result.status }),
          onError: error =>
            dispatch({
              type: 'CLAIM_FAILED',
              error: toFlowError(toPairingErrorCode(error)),
            }),
        }
      )
    },
    [claimMutate]
  )

  // El robot trabaja con el negocio elegido en la web: no se pregunta aquí.
  const needsBusiness = false
  const [helloNonce, setHelloNonce] = useState(0)
  const sayHello = useCallback(() => {
    setHelloNonce(n => n + 1)
    transport.sayHello?.()
  }, [transport])
  const actions = useFlowActions({
    model,
    dispatch,
    needsBusiness,
    runClaim,
    sayHello,
    unpair: unpair.mutate,
    setForbiddenTyped,
    setUnpairFailed,
  })

  return {
    model,
    needsBusiness,
    business: businesses.find(b => b.id === model.businessId) ?? null,
    syncStep: status.data?.sync_step ?? null,
    syncSlow,
    device: status.data?.device ?? null,
    claiming: claim.isPending,
    unpairing: unpair.isPending,
    unpairFailed,
    forbiddenTyped,
    helloNonce,
    actions,
  }
}
