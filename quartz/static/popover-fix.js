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

        // try multiple times as content loads asynchronously
        attemptScroll(inner, hash, 0)
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
}

function attemptScroll(inner, hash, attempt) {
  if (attempt > 5) return
  setTimeout(() => {
    const decodedHash = decodeURIComponent(hash)
    const target =
      inner.querySelector(`#popover-internal-${CSS.escape(decodedHash)}`) ||
      inner.querySelector(`[id="popover-internal-${decodedHash}"]`)

    if (target) {
      inner.scrollTop = target.offsetTop
    } else {
      attemptScroll(inner, hash, attempt + 1)
    }
  }, 100 * (attempt + 1))
}

function getHashForPopover(popoverEl) {
  const popoverId = popoverEl.id
  // decode the slug from the popover id since it may be URL-encoded
  const slug = decodeURIComponent(popoverId.replace(/^popover-/, ""))

  // find matching link by decoding both sides
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