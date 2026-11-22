import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SourceHeaderSelect } from './SourceHeaderSelect.jsx'

const REGION = '[data-slot="sidebar.workspaces"]'
const SIDEBAR = '[data-slot="sidebar"]'
const HEADER = '[data-sidebar-workspace-header]'
const OWNED = 'data-dsh-agents-source'
const WIDE_MIN_PX = 120
const GRACE_MS = 1500

/**
 * The shipped dsh browsing region owns its section header and exposes no seat
 * inside it, so while dsh is selected the workspace dropdown is portaled into
 * that header in place of its static label. The label is restored on unmount;
 * if the header cannot be found (rail layout, a future dsh rename) the caller
 * falls back to the switch beside New session.
 */
export function SourceHeaderPortal(props) {
  const { t, useAgentView, setSource, setChrome } = props
  const source = useAgentView(s => s.source)
  const [container, setContainer] = useState(null)
  const hidden = useRef(null)
  const owned = useRef(null)
  const sourceRef = useRef(source)
  sourceRef.current = source

  useEffect(() => {
    if (source !== 'dsh') {
      setContainer(null)
      setChrome({ headerMounted: false, headerFailed: false })
      return
    }
    let frame
    let disposed = false
    const started = Date.now()
    const resize = new ResizeObserver(() => schedule())
    const restore = () => {
      resize.disconnect()
      if (hidden.current !== null) {
        hidden.current.style.display = ''
        hidden.current = null
      }
      if (owned.current !== null) {
        owned.current.remove()
        owned.current = null
      }
    }
    const locate = () => {
      if (disposed || sourceRef.current !== 'dsh') return
      const header = document.querySelector(REGION)?.querySelector(HEADER) ?? null
      // Slot anchors are display:contents and have no box; the header itself
      // is the real flex row, narrow in the rail layout.
      const wide = header !== null && header.getBoundingClientRect().width >= WIDE_MIN_PX
      if (!wide) {
        restore()
        setContainer(null)
        setChrome({ headerMounted: false, headerFailed: Date.now() - started > GRACE_MS })
        return
      }
      const label = header.querySelector(':scope > span')
      if (label !== null && hidden.current !== label) {
        if (hidden.current !== null) hidden.current.style.display = ''
        label.style.display = 'none'
        hidden.current = label
      }
      let slot = header.querySelector(`[${OWNED}]`)
      if (slot === null) {
        slot = document.createElement('div')
        slot.setAttribute(OWNED, '')
        header.insertBefore(slot, header.firstChild)
      }
      // The shipped search collapses the label to zero width when expanded;
      // follow it so the search field keeps the whole row.
      const searchExpanded = label !== null && getComputedStyle(label).maxWidth === '0px'
      slot.style.display = searchExpanded ? 'none' : 'contents'
      owned.current = slot
      resize.observe(header)
      setContainer(slot)
      setChrome({ headerMounted: true, headerFailed: false })
    }
    const schedule = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        locate()
      })
    }
    locate()
    const sidebar = document.querySelector(SIDEBAR)
    const observer = new MutationObserver(schedule)
    if (sidebar !== null) observer.observe(sidebar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    const retry = setInterval(schedule, GRACE_MS)
    return () => {
      disposed = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      clearInterval(retry)
      observer.disconnect()
      restore()
      setChrome({ headerMounted: false, headerFailed: false })
    }
  }, [source, setChrome])

  if (container === null) return null
  return createPortal(<SourceHeaderSelect t={t} useAgentView={useAgentView} setSource={setSource} />, container, 'dsh-agents-source')
}
