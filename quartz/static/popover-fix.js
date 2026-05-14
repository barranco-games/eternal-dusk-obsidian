document.addEventListener("DOMContentLoaded", () => { startObserver() })
document.addEventListener("nav", () => { startObserver() })

function startObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue
        const el = node
        if (!el.classList?.contains("popover")) continue

        const hash = getHashForPopover(el)
        if (!hash) continue

        attemptScroll(el, hash, 0)
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
}

function attemptScroll(popoverEl, hash, attempt) {
  if (attempt > 8) return
  setTimeout(() => {
    const decodedHash = decodeURIComponent(hash)

    // try all possible scrollable containers
    const containers = [
      popoverEl.querySelector(".popover-inner"),
      popoverEl.querySelector(".popover-content"),
      popoverEl,
    ].filter(Boolean)

    const target = popoverEl.querySelector(`#popover-internal-${CSS.escape(decodedHash)}`) ||
                   popoverEl.querySelector(`[id="popover-internal-${decodedHash}"]`)

    if (target) {
      // try scrolling every possible container
      for (const container of containers) {
        container.scrollTop = target.offsetTop
      }
      // also try scrollIntoView as last resort
      target.scrollIntoView({ block: "start", behavior: "instant" })
    } else {
      attemptScroll(popoverEl, hash, attempt + 1)
    }
  }, 150 * (attempt + 1))
}

function getHashForPopover(popoverEl) {
  const popoverId = popoverEl.id
  const slug = decodeURIComponent(popoverId.replace(/^popover-/, ""))
  const links = document.querySelectorAll("a.internal")
  for (const link of links) {
    const decoded = decodeURIComponent(link.href)
    if (decoded.includes(slug)) {
      const url = new URL(link.href)
      return url.hash?.slice(1) || null
    }
  }
  return null
}