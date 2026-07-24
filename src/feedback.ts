// src/feedback.ts — SHIM (managed by hub/scripts/feedback).
//
// The feedback widget is no longer bundled into this product. It is served
// centrally from https://feedback.benrichardson.dev/w.js and loaded by the
// <script> tag in index.html, so it updates in one place without rebuilding
// this product.
//
// These stubs exist only so any remaining `import … from './feedback'` in this
// product keeps compiling. The hosted script mounts the footer trigger itself,
// so mountFeedback() is a deliberate no-op; openFeedback() forwards to the
// hosted widget's global entry point.

export interface FeedbackOptions {
  mount?: Element | null;
  label?: string;
  build?: string;
  endpoint?: string;
  returnFocusTo?: HTMLElement | null;
}

export function mountFeedback(_options: FeedbackOptions = {}): void {
  /* the hosted widget auto-mounts; nothing to do here */
}

export function openFeedback(options: FeedbackOptions = {}): void {
  (window as unknown as { feedback?: { open(o?: FeedbackOptions): void } }).feedback?.open(options);
}
