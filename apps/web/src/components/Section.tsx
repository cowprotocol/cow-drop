import type { ReactNode } from 'react'

/** A numbered form section that folds behind its heading. */
export function Section({
  title,
  open = true,
  optional = false,
  className,
  children,
}: {
  title: ReactNode
  /** Initial state only; the user toggles it after. */
  open?: boolean
  /**
   * Whether the drop works without ever opening this panel.
   *
   * Worth saying out loud rather than leaving to be inferred from the panel starting closed. Half
   * these steps are things you may never need — reading the committed steps, rescuing funds, editing
   * the recipe file — and a numbered list of eight implies all eight are the path.
   */
  optional?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section>
      <details className={['collapsed-section', className].filter(Boolean).join(' ')} open={open}>
        <summary>
          <h2>
            {title}
            {optional && <span className="section-optional">Optional</span>}
          </h2>
        </summary>
        {children}
      </details>
    </section>
  )
}
