import type { ReactNode } from 'react'

/** A numbered form section that folds behind its heading. */
export function Section({
  title,
  open = true,
  className,
  children,
}: {
  title: ReactNode
  /** Initial state only; the user toggles it after. */
  open?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section>
      <details className={['collapsed-section', className].filter(Boolean).join(' ')} open={open}>
        <summary>
          <h2>{title}</h2>
        </summary>
        {children}
      </details>
    </section>
  )
}
