// Sub-frame position, capped the way Bitwarden caps MAX_SUB_FRAME_DEPTH.
// The menu is drawn in the field's own frame, so callers add this only when
// a parent frame is placing a top-frame menu for a child rect.
// known is false when the walk stopped early: a cross-origin parent hides frameElement.

export const MAX_SUB_FRAME_DEPTH = 8;

export function frameOffsetFromWindow(win) {
  let x = 0;
  let y = 0;
  let depth = 0;
  let w = win;
  let known = true;
  while (w && w !== w.top) {
    let fe = null;
    try {
      fe = depth < MAX_SUB_FRAME_DEPTH ? w.frameElement : null;
    } catch {
      fe = null;
    }
    if (!fe || !fe.getBoundingClientRect) {
      known = false;
      break;
    }
    const r = fe.getBoundingClientRect();
    const s = w.parent.getComputedStyle(fe);
    x += r.left + (parseFloat(s.borderLeftWidth) || 0) + (parseFloat(s.paddingLeft) || 0);
    y += r.top + (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.paddingTop) || 0);
    w = w.parent;
    depth++;
  }
  return { x, y, depth, known };
}
