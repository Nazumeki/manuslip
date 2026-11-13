import { type ReactNode, type RefObject, useId, useState } from 'react'
import { Icon, type IconName } from './Icons'

export function ToolbarDisclosure({
  label,
  children,
  triggerRef,
  icon,
  iconOnly = false,
  summary,
  onOpenChange,
}: {
  label: string
  children: ReactNode
  triggerRef?: RefObject<HTMLButtonElement | null>
  icon?: IconName
  iconOnly?: boolean
  summary?: string
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={triggerRef}
        className={`toolbar-disclosure${iconOnly ? ' icon-button' : ''}`}
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        aria-label={summary ? `${summary} · ${label}` : undefined}
        title={iconOnly || summary ? label : undefined}
      >
        {icon && <Icon name={icon} size={iconOnly ? 18 : 16} />}
        <span className={iconOnly ? 'visually-hidden' : undefined}>{summary ?? label}</span>
        {!iconOnly && <Icon name="chevron" size={12} />}
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Delegates native button clicks, including Enter and Space activation. */}
      <fieldset
        id={id}
        className="toolbar-popover"
        popover="auto"
        inert={!open}
        aria-label={label}
        onBeforeToggle={(event) => {
          const open = event.newState === 'open'
          setOpen(open)
          onOpenChange?.(open)
        }}
        onClick={(event) => {
          // Activate the command before hiding its control and making the panel inert.
          if (
            event.target instanceof Element &&
            event.target.closest('button') &&
            event.currentTarget.matches(':popover-open')
          )
            event.currentTarget.hidePopover()
        }}
      >
        {children}
      </fieldset>
    </>
  )
}
