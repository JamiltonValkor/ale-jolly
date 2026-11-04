import { SpinnerGap } from '@phosphor-icons/react'

export function GradientSpinner() {
  return (
    <span
      className="from-sa-interactive-accent to-sa-interactive-primary inline-flex size-8 items-center justify-center rounded-lg bg-gradient-to-r"
      aria-hidden="true"
    >
      <SpinnerGap size={18} weight="bold" className="animate-spin text-white" />
    </span>
  )
}
