import type { ComponentProps, ReactNode } from "react";
import { Button as AriaButton, Dialog, Heading, Input as AriaInput, Label, Modal, ModalOverlay, TextField } from "react-aria-components";
import { cn } from "../lib/cn";

// Source-owned adaptations of the MIT-licensed Untitled UI React button,
// input, badge, and modal patterns. See THIRD_PARTY_NOTICES.md.

export function Button({ className, variant = "primary", ...props }: ComponentProps<typeof AriaButton> & { variant?: "primary" | "secondary" | "ghost" | "danger" }): ReactNode {
  return <AriaButton {...props} className={cn("inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-45", variant === "primary" && "bg-violet-600 text-white hover:bg-violet-700", variant === "secondary" && "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50", variant === "ghost" && "text-slate-600 hover:bg-slate-100", variant === "danger" && "bg-red-50 text-red-700 hover:bg-red-100", className)} />;
}

export function Field({ label, className, ...props }: ComponentProps<typeof AriaInput> & { label: string; className?: string }): ReactNode {
  return <TextField className={cn("grid gap-1.5", className)}><Label className="text-xs font-medium text-slate-600">{label}</Label><AriaInput {...props} className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-100" /></TextField>;
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "violet" | "red" }): ReactNode {
  const tones = { slate: "bg-slate-100 text-slate-600", green: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-700", violet: "bg-violet-50 text-violet-700", red: "bg-red-50 text-red-700" };
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", tones[tone])}>{children}</span>;
}

export function AppModal({ open, onOpenChange, title, children, size = "lg" }: { open: boolean; onOpenChange(open: boolean): void; title: string; children: ReactNode; size?: "md" | "lg" | "xl" }): ReactNode {
  return <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-6 backdrop-blur-[2px]"><Modal className={cn("max-h-[88vh] w-full overflow-hidden rounded-2xl bg-white shadow-2xl outline-none", size === "md" && "max-w-lg", size === "lg" && "max-w-2xl", size === "xl" && "max-w-5xl")}><Dialog className="flex max-h-[88vh] flex-col outline-none"><div className="border-b border-slate-200 px-6 py-4"><Heading slot="title" className="text-lg font-semibold text-slate-900">{title}</Heading></div>{children}</Dialog></Modal></ModalOverlay>;
}
