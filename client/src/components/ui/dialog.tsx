"use client"

// The ONE dialog wrapper (AF-wide dialog rule, Maria 2026-11-01). Every modal
// in AF renders through DialogContent (or AlertDialogContent, which shares
// the frame below):
//   - resizable by dragging the right edge, the bottom edge or the
//     bottom-right corner; min 480×320; max = the viewport minus a 32 px
//     margin; the size is remembered per dialog in localStorage
//     (`af-dialog-size:<dialogId>` — per browser, like the column widths;
//     both move to a user-scoped table with the queued Buy-List-to-DB patch);
//   - default size = the content's size, capped at 90 % of the viewport both
//     ways (width: the dialog's max-w-* class, as designed);
//   - the body scrolls vertically when the content exceeds the height; the
//     DialogHeader and DialogFooter children stay pinned;
//   - NEVER a horizontal scroll: the body hides x-overflow and wraps text;
//     a table goes inside <DialogTable> — its own overflow-x box with the
//     first column sticky;
//   - closes with Esc, × or a backdrop click; `confirm` dialogs ignore the
//     backdrop.
import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

export const DIALOG_MIN_W = 480
export const DIALOG_MIN_H = 320
export const DIALOG_MARGIN = 32
export const dialogSizeKey = (id: string) => `af-dialog-size:${id}`

export interface DialogSize { w: number; h: number }
/** Pure: the stored size, clamped to the rule (min 480×320, max viewport − 32); null when none / unusable. */
export function clampDialogSize(size: Partial<DialogSize> | null | undefined, viewport: { w: number; h: number }): DialogSize | null {
  if (!size || typeof size.w !== "number" || typeof size.h !== "number" || !Number.isFinite(size.w) || !Number.isFinite(size.h)) return null
  const maxW = Math.max(DIALOG_MIN_W, viewport.w - DIALOG_MARGIN), maxH = Math.max(DIALOG_MIN_H, viewport.h - DIALOG_MARGIN)
  return { w: Math.round(Math.min(Math.max(size.w, DIALOG_MIN_W), maxW)), h: Math.round(Math.min(Math.max(size.h, DIALOG_MIN_H), maxH)) }
}
export function readDialogSize(id: string): DialogSize | null {
  try { const raw = localStorage.getItem(dialogSizeKey(id)); return raw ? clampDialogSize(JSON.parse(raw), { w: window.innerWidth, h: window.innerHeight }) : null } catch { return null }
}
export function writeDialogSize(id: string, size: DialogSize): void {
  try { localStorage.setItem(dialogSizeKey(id), JSON.stringify(size)) } catch { /* storage unavailable */ }
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

/** A table inside a dialog: its own horizontal scroll box with the first column sticky (the dialog itself never scrolls sideways). */
const DialogTable = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("af-dialog-table max-w-full overflow-x-auto", className)} {...props} />
)
DialogTable.displayName = "DialogTable"

/** The frame every dialog renders through: pinned header / footer, a scrolling body, the resize handles, the remembered size. */
export function useDialogFrame(dialogId: string, children: React.ReactNode, pinnedTypes: readonly unknown[]) {
  const [size, setSize] = React.useState<DialogSize | null>(() => (typeof window === "undefined" ? null : readDialogSize(dialogId)))
  const [pin, setPin] = React.useState<{ left: number; top: number } | null>(null)
  const drag = React.useRef<{ edge: "r" | "b" | "rb"; x: number; y: number; w: number; h: number; left: number; top: number } | null>(null)
  const box = React.useRef<HTMLDivElement | null>(null)

  const onDown = (edge: "r" | "b" | "rb") => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    drag.current = { edge, x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top }
    setPin({ left: r.left, top: r.top })
    setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const want = { w: d.edge === "b" ? d.w : d.w + (e.clientX - d.x), h: d.edge === "r" ? d.h : d.h + (e.clientY - d.y) }
    const vp = { w: window.innerWidth, h: window.innerHeight }
    const c = clampDialogSize(want, vp)!
    // Keep the dialog inside the margin on the right / bottom while its top-left stays put.
    c.w = Math.min(c.w, vp.w - DIALOG_MARGIN / 2 - d.left)
    c.h = Math.min(c.h, vp.h - DIALOG_MARGIN / 2 - d.top)
    setSize(c)
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || !box.current) return
    const r = box.current.getBoundingClientRect()
    const c = clampDialogSize({ w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight })
    if (c) { setSize(c); writeDialogSize(dialogId, c) }
  }

  const pinned: React.ReactNode[] = [], body: React.ReactNode[] = [], footers: React.ReactNode[] = []
  React.Children.toArray(children).forEach((child) => {
    const t = React.isValidElement(child) ? (child.type as unknown) : null
    if (t === pinnedTypes[0]) pinned.push(child)
    else if (t === pinnedTypes[1]) footers.push(child)
    else body.push(child)
  })
  const handle = "absolute z-10 touch-none select-none"
  const handles = (
    <>
      <div className={`${handle} right-0 top-3 bottom-3 w-1.5 cursor-ew-resize`} onPointerDown={onDown("r")} onPointerMove={onMove} onPointerUp={onUp} data-testid="dialog-resize-right" />
      <div className={`${handle} bottom-0 left-3 right-3 h-1.5 cursor-ns-resize`} onPointerDown={onDown("b")} onPointerMove={onMove} onPointerUp={onUp} data-testid="dialog-resize-bottom" />
      <div className={`${handle} bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize rounded-tl-sm bg-muted-foreground/25`} onPointerDown={onDown("rb")} onPointerMove={onMove} onPointerUp={onUp} data-testid="dialog-resize-corner" title="Drag to resize" />
    </>
  )
  // Default: as wide as the viewport allows (90 %, minus the margin) — the dialog's own max-w-* class caps that at its
  // designed width (an inline max-width would beat the class, so the cap goes on width); height = content, capped at 90 %.
  // Sized: the remembered width / height, the class cap lifted (inline max-width wins), the viewport margin kept.
  const style: React.CSSProperties = {
    width: `min(90vw, calc(100vw - ${DIALOG_MARGIN}px))`,
    maxHeight: `min(90vh, calc(100vh - ${DIALOG_MARGIN}px))`,
    minWidth: `min(${DIALOG_MIN_W}px, calc(100vw - ${DIALOG_MARGIN}px))`,
    ...(size ? { width: size.w, height: size.h, maxWidth: `calc(100vw - ${DIALOG_MARGIN}px)` } : {}),
    ...(pin ? { left: pin.left, top: pin.top, transform: "none" } : {}),
  }
  return { box, style, handles, pinned, body, footers, sized: !!size }
}

const FRAME = "fixed left-[50%] top-[50%] z-50 flex w-full max-w-lg translate-x-[-50%] translate-y-[-50%] flex-col border bg-background shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg"
export const DIALOG_FRAME_CLASS = FRAME
export const DIALOG_BODY_CLASS = "af-dialog-body min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-2 [overflow-wrap:anywhere] [&>*]:min-w-0"

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** The localStorage key for the remembered size; one per dialog. */
  dialogId: string
  /** A confirm dialog: Esc and × close it, the backdrop does nothing. */
  confirm?: boolean
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, dialogId, confirm = false, onPointerDownOutside, onInteractOutside, ...props }, ref) => {
  const f = useDialogFrame(dialogId, children, [DialogHeader, DialogFooter])
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={(el) => { f.box.current = el; if (typeof ref === "function") ref(el); else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el }}
        className={cn(FRAME, className)}
        style={f.style}
        data-dialog-id={dialogId}
        onPointerDownOutside={(e) => { if (confirm) e.preventDefault(); onPointerDownOutside?.(e) }}
        onInteractOutside={(e) => { if (confirm) e.preventDefault(); onInteractOutside?.(e) }}
        {...props}
      >
        {f.pinned.length > 0 && <div className="shrink-0 px-6 pb-2 pt-6">{f.pinned}</div>}
        <div className={cn(DIALOG_BODY_CLASS, f.pinned.length === 0 && "pt-6", f.footers.length === 0 && "pb-6")}>{f.body}</div>
        {f.footers.length > 0 && <div className="shrink-0 px-6 pb-6 pt-2">{f.footers}</div>}
        {f.handles}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogTable,
}
