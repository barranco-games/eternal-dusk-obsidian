import { QuartzComponent, QuartzComponentProps } from "./types"

const PopoverFix: () => QuartzComponent = () => {
  const PopoverFixComponent: QuartzComponent = (_props: QuartzComponentProps) => {
    return <script src="/static/popover-fix.js" defer></script>
  }
  return PopoverFixComponent
}

export default PopoverFix