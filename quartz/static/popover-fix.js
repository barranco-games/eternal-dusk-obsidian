document.addEventListener("DOMContentLoaded", () => {
  patchPopovers()
})

document.addEventListener("nav", () => {
  patchPopovers()
})

function patchPopovers() {
  document.querySelectorAll("a.internal").forEach((link) => {
    link.addEventListener("mouseenter", () => {
      // give quartz time to render the popover
      setTimeout(() => {
        const popover = link.querySelector(".popover")
        if (!popover) return

        const url = new URL(link.href)
        const hash = url.hash?.slice(1)
        if (!hash) return

        const inner = popover.querySelector(".popover-inner")
        if (!inner) return

        // find the anchor target inside the popover
        const target =
          inner.querySelector(`#${CSS.escape(hash)}`) ||
          inner.querySelector(`[id="${hash}"]`)

        if (target) {
          target.scrollIntoView({ block: "start" })
        }
      }, 50)
    })
  })
}