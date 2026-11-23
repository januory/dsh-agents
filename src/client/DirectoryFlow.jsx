/**
 * dsh's composed directory-flow occupant (native chooser or in-browser browse
 * dialog) driven by our owner conversation. The occupant component and its
 * injected face come from the slot registry, so neither backend is reimplemented
 * here and no dsh workspace is created as a side effect of adopting a path.
 */
export function DirectoryFlow({ occupant, open, busy, onPicked, onCancel, onError }) {
  if (occupant == null) return null
  const { Component, face } = occupant
  return <Component open={open} busy={busy} onPicked={onPicked} onCancel={onCancel} onError={onError} {...face} />
}
