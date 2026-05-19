/**
 * ScreenshotLightbox — full-bleed in-app modal for viewing a single screenshot
 * at its native size.
 *
 * Replaces the v0.9.3-initial behaviour where clicking a thumbnail opened the
 * `mosaiq-artifact://` URL in a new window — that worked but lost focus on
 * the app. This keeps the user inside Mosaiq and adds basic UX affordances:
 *
 *   - native `<dialog>` element ⇒ proper a11y, focus trap, and Escape-to-close
 *     handled by the platform (we just listen to the `cancel` event)
 *   - `::backdrop` styling for the dim overlay
 *   - centered image, object-contain so any aspect ratio fits
 *   - top bar: site name + close button
 *   - closes on:
 *       * click on backdrop (via dialog's click-on-backdrop check)
 *       * press Escape (native `cancel` event)
 *       * click the close button
 *
 * Why native `<dialog>` instead of a portal'd `<div role="dialog">`:
 *   - Free focus trap — Tab cycles inside the dialog only when shown via
 *     `showModal()` and modal restores prior focus on close.
 *   - Escape handling baked in (fires `cancel` then `close`).
 *   - Native a11y semantics — no manual aria-modal / role gymnastics.
 *   - Stacks above all app content (top layer) without z-index wars.
 */

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface ScreenshotLightboxProps {
  /** `mosaiq-artifact://...` URL or any URL the renderer can fetch under CSP. */
  src: string;
  /** Used as `<img alt>` and as the title in the top bar. */
  alt: string;
  /** Whether the lightbox is visible. */
  open: boolean;
  /** Called when the user requests close (backdrop, Escape, or close button). */
  onClose: () => void;
}

export function ScreenshotLightbox({ src, alt, open, onClose }: ScreenshotLightboxProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Sync `open` prop ⇄ native dialog open/close. `showModal()` puts the
  // dialog in the top layer, traps focus, and enables ::backdrop. We must
  // not call it on an already-open dialog (throws InvalidStateError), hence
  // the .open guard.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={alt}
      onCancel={(e) => {
        // Default `cancel` (Esc) would close the dialog; we let it close
        // and also notify the parent so the controlled `open` prop stays
        // in sync. preventDefault keeps native close from racing our
        // useEffect-driven close path.
        e.preventDefault();
        onClose();
      }}
      className="m-0 h-screen max-h-screen w-screen max-w-screen border-0 bg-transparent p-0 backdrop:bg-black/80 backdrop:backdrop-blur-sm"
    >
      <div className="flex h-full w-full flex-col text-white">
        {/* top bar — clicks here don't close (own button is the only action) */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-sm">
          <span className="truncate font-medium">{alt}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* image stage — the stage itself is a click-target that closes the
            lightbox (so clicks on the dim area around the image close). We
            only fire close when the click landed on the stage element
            itself; clicks on the inner <img> have e.target === img and are
            ignored. Keyboard close is handled by the dialog's native
            cancel-on-Escape (and the X button in the top bar). */}
        <button
          type="button"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          aria-label="关闭"
          className="flex flex-1 cursor-zoom-out items-center justify-center overflow-auto bg-transparent p-4"
        >
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full cursor-default select-none object-contain shadow-2xl"
            draggable={false}
          />
        </button>
      </div>
    </dialog>
  );
}
