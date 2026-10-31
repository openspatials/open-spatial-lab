/*
 * The footer's real height, for what stands above it. On a small phone the attribution wraps the footer to two lines,
 * so a fixed height would let an open panel overlap it. This publishes the measured height as a CSS variable,
 * --osl-footer-measured, which web/index.html's panel heights read. The footer's own min-height does not read it, so a
 * footer that shrinks can still report the smaller height.
 */

const FOOTER_SELECTOR = "footer.controls";
const VARIABLE = "--osl-footer-measured";

/** Keep the variable up to date from now on. A page with no footer keeps the fixed height. Returns a stop function. */
export function followFooterHeight(doc) {
  const footer = doc.querySelector(FOOTER_SELECTOR);
  if (!footer) return () => {};
  const publish = () => {
    const height = footer.getBoundingClientRect().height;
    if (height > 0) doc.documentElement.style.setProperty(VARIABLE, `${Math.ceil(height)}px`);
  };
  publish();
  const observer = new ResizeObserver(publish);
  observer.observe(footer);
  return () => observer.disconnect();
}
