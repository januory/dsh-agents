import { FishLogo, IconCodeOutlineMedium, IconSparkleMedium } from '@deepseek-ai/dsh-client-ui-primitives'

export function SourceIcon({ source, size = 14, className }) {
  if (source === 'claude') return <IconSparkleMedium size={size} className={className} />
  if (source === 'codex') return <IconCodeOutlineMedium size={size} className={className} />
  return <FishLogo size={size} className={className} />
}

export function sourceColor(source) {
  if (source === 'claude') return '#D97757'
  if (source === 'codex') return '#10A37F'
  return 'var(--dsw-alias-state-business-primary)'
}
