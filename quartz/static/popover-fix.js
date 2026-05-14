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
        console.log("Node added:", el.className, el.id)
        if (!el.classList?.contains("popover")) continue

        console.log("Popover detected:", el.id)

        const inner = el.querySelector(".popover-inner")
        console.log("Inner:", inner)

        const hash = getHashForPopover(el)
        console.log("Hash:", hash)

        if (!hash || !inner) continue

        setTimeout(() => {
          const target =
            inner.querySelector(`#popover-internal-${CSS.escape(hash)}`) ||
            inner.querySelector(`[id="popover-internal-${hash}"]`)
          console.log("Target:", target)
          if (target) {
            console.log("Scrolling to:", target.id, "offsetTop:", target.offsetTop)
            inner.scrollTop = target.offsetTop
          }
        }, 50)
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
}

function getHashForPopover(popoverEl) {
  const popoverId = popoverEl.id
  const slug = popoverId.replace(/^popover-/, "")
  console.log("Looking for link with slug:", slug)
  const link = document.querySelector(`a.internal[href*="${slug}"]`)
  console.log("Found link:", link?.href)
  if (!link) return null
  const url = new URL(link.href)
  return url.hash?.slice(1) || null
}