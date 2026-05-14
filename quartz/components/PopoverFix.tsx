import { QuartzComponent, QuartzComponentProps } from "./types"
import { pathToRoot } from "../util/path"

const PopoverFix: () => QuartzComponent = () => {
  const PopoverFixComponent: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
    const base = pathToRoot(fileData.slug!)
    return <script src={`${base}/static/popover-fix.js`} defer></script>
  }
  return PopoverFixComponent
}

export default PopoverFix