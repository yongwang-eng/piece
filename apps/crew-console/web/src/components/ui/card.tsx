import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** work_hub's Card: white on paper, hairline border, soft shadow. The console adds `accent` for the left-edge stripe. */
function Card({ className, accent, ...props }: ComponentProps<"div"> & { accent?: "signal" | "ok" | "warn" | "info" | "neutral" | "destructive" | null }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        accent && "border-l-[3px]",
        accent === "signal" && "border-l-signal",
        accent === "ok" && "border-l-ok",
        accent === "warn" && "border-l-warn",
        accent === "info" && "border-l-info",
        accent === "neutral" && "border-l-neutral",
        accent === "destructive" && "border-l-destructive",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-between gap-3 border-b border-border px-4 py-2.5", className)} {...props} />;
}

function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground", className)} {...props} />;
}

export { Card, CardHeader, CardTitle };
