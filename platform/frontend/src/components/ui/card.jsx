import { cn } from "@/lib/utils";
export function Card({ className, ...props }) {
  return (
    <section
      className={cn("rounded-xl border border-border bg-card", className)}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }) {
  return (
    <div className={cn("flex flex-col gap-1.5 p-5", className)} {...props} />
  );
}
export function CardTitle({ className, ...props }) {
  return (
    <h3
      className={cn("text-sm font-medium tracking-tight", className)}
      {...props}
    />
  );
}
export function CardContent({ className, ...props }) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}
