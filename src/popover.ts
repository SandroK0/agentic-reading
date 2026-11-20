/**
 * Closes a popover or dropdown the way menus do: on a click outside it and
 * its button, or on Escape. The settings menu, the Aa menu and the EPUB
 * contents dropdown all close this way.
 */
export function closeWhenDismissed(panel: HTMLElement, button: HTMLElement, isOpen: () => boolean, close: () => void) {
  document.addEventListener("mousedown", (e) => {
    const target = e.target as Node;
    if (isOpen() && !panel.contains(target) && !button.contains(target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });
}
