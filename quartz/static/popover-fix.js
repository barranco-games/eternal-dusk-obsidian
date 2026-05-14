document.addEventListener("DOMContentLoaded", () => {
  startObserver()
})

document.addEventListener("nav", () => {
  startObserver()
})

function startObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue
        const el = node
        if (!el.classList?.contains("popover")) continue

        // get the hash from the popover's id
        // id format: "popover-/path/to/note"
        // we need the hash from the link that triggered it
        const hash = getHashForPopover(el)
        if (!hash) continue

        const inner = el.querySelector(".popover-inner")
        if (!inner) continue

        // wait for content to render
        setTimeout(() => {
          const target =
            inner.querySelector(`#popover-internal-${CSS.escape(hash)}`) ||
            inner.querySelector(`[id="popover-internal-${hash}"]`)

          if (target) {
            inner.scrollTop = target.offsetTop
          }
        }, 50)
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
}

function getHashForPopover(popoverEl) {
  // find the hovered link by matching the popover id to the link href
  const popoverId = popoverEl.id // e.g. "popover-/path/to/note"
  const slug = popoverId.replace(/^popover-/, "")

  const link = document.querySelector(`a.internal[href*="${slug}"]`)
  if (!link) return null

  const url = new URL(link.href)
  return url.hash?.slice(1) || null
}