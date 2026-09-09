import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "solid" | "ghost";
  size?: "md" | "sm";
  busy?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "solid", size = "md", busy, icon, children, className = "", disabled, ...rest }: Props) {
  const classes = ["btn", variant === "ghost" && "btn--ghost", size === "sm" && "btn--sm", className]
    .filter(Boolean).join(" ");
  return (
    <button className={classes} disabled={disabled || busy} {...rest}>
      {busy ? <Loader2 size={14} /> : icon}
      {children}
    </button>
  );
}
