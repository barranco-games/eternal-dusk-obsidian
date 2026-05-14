document.addEventListener("DOMContentLoaded", () => { startObserver() })
document.addEventListener("nav", () => { startObserver() })

function startObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue
        const el = node
        if (!el.classList?.contains("popover")) continue

        const inner = el.querySelector(".popover-inner")
        const hash = getHashForPopover(el)
        if (!hash || !inner) continue

        setTimeout(() => {
          // decode the hash in case it's URL-encoded
          const decodedHash = decodeURIComponent(hash)
          const target =
            inner.querySelector(`#popover-internal-${CSS.escape(decodedHash)}`) ||
            inner.querySelector(`[id="popover-internal-${decodedHash}"]`)

          if (target) {
            // scroll the popover-inner container
            target.scrollIntoView({ block: "start" })
            // also try direct scrollTop as fallback
            inner.scrollTop = target.offsetTop
          }
        }, 100)
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
}

function getHashForPopover(popoverEl) {
  const popoverId = popoverEl.id
  const slug = popoverId.replace(/^popover-/, "")
  const link = document.querySelector(`a.internal[href*="${slug}"]`)
  if (!link) return null
  const url = new URL(link.href)
  return url.hash?.slice(1) || null
}