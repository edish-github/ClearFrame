import type { HTMLAttributes, ReactNode } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  pad?: boolean;
  children: ReactNode;
}

export function Card({ pad = true, children, className = "", ...rest }: Props) {
  return (
    <div className={["card", pad && "card--pad", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
