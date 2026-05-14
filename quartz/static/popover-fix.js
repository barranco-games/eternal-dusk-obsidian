document.addEventListener("DOMContentLoaded", () => {
  patchPopovers()
})

document.addEventListener("nav", () => {
  patchPopovers()
})

function patchPopovers() {
  document.querySelectorAll("a.internal").forEach((link) => {
    link.addEventListener("mouseenter", () => {
      setTimeout(() => {
        const popover = link.querySelector(".popover")
        if (!popover) return

        const url = new URL(link.href)
        const hash = url.hash?.slice(1)
        if (!hash) return

        const inner = popover.querySelector(".popover-inner")
        if (!inner) return

        // quartz prefixes ids with "popover-internal-" inside popovers
        const target =
          inner.querySelector(`#popover-internal-${CSS.escape(hash)}`) ||
          inner.querySelector(`#${CSS.escape(hash)}`)

        if (target) {
          inner.scrollTop = target.offsetTop
        }
      }, 50)
    })
  })
}