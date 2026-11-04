import { useState, useRef, useEffect, useCallback } from 'react'

const SPINNER_DURATION = 1500
const PRIMARY_SPINNER_DURATION = 2000

interface UseSpinnerTimerOptions {
  onClick?: () => void
  onSpinnerComplete?: () => void
  isLoading: boolean
  variant: string
  spinnerDuration?: number
}

export function useSpinnerTimer({
  onClick,
  onSpinnerComplete,
  isLoading,
  variant,
  spinnerDuration,
}: UseSpinnerTimerOptions) {
  const [isSpinnerActive, setIsSpinnerActive] = useState(false)
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  const onClickRef = useRef(onClick)
  useEffect(() => {
    onClickRef.current = onClick
  }, [onClick])

  const onSpinnerCompleteRef = useRef(onSpinnerComplete)
  useEffect(() => {
    onSpinnerCompleteRef.current = onSpinnerComplete
  }, [onSpinnerComplete])

  useEffect(() => {
    return () => {
      if (spinnerTimerRef.current) clearTimeout(spinnerTimerRef.current)
    }
  }, [])

  const handleSpinnerClick = useCallback(() => {
    if (isSpinnerActive || isLoading) return
    setIsSpinnerActive(true)
    spinnerTimerRef.current = setTimeout(
      () => {
        setIsSpinnerActive(false)
        onClickRef.current?.()
        onSpinnerCompleteRef.current?.()
      },
      spinnerDuration ??
        (variant === 'primary-spinner'
          ? PRIMARY_SPINNER_DURATION
          : SPINNER_DURATION)
    )
  }, [isSpinnerActive, isLoading, variant, spinnerDuration])

  return { isSpinnerActive, handleSpinnerClick }
}
