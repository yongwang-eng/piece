import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type BadgeVariant = "default" | "outline" | "signal" | "ok" | "warn" | "info" | "neutral" | "destructive";

/* Status tones map to the semantic CSS vars in index.css — hand-written in place of work_hub's cva. */
const VARIANTS: Record<BadgeVariant, string> = {
  default: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border text-muted-foreground",
  signal: "border-transparent bg-signal/15 text-signal",
  ok: "border-transparent bg-ok/15 text-ok",
  warn: "border-transparent bg-warn/15 text-warn",
  info: "border-transparent bg-info/15 text-info",
  neutral: "border-transparent bg-neutral/15 text-neutral",
  destructive: "border-transparent bg-destructive/12 text-destructive",
};

function Badge({ className, variant = "default", ...props }: ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium leading-none transition-colors [&_svg]:size-3", VARIANTS[variant], className)}
      {...props}
    />
  );
}

export { Badge };
