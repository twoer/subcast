import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

export const badgeVariants = cva(
  "inline-flex gap-1 items-center border font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
        active: "border-transparent bg-primary/10 text-primary hover:bg-primary/15",
      },
      // Status/state badges across the app standardised on the `sm` size
      // (10px text, square-ish corners) for visual density. `default`
      // remains the bigger pill-shaped Badge for callouts like the
      // "recommended" highlight in the setup wizard.
      size: {
        default: "rounded-full px-2.5 py-0.5 text-xs",
        sm: "rounded-sm px-1.5 py-0.5 text-3xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type BadgeVariants = VariantProps<typeof badgeVariants>
