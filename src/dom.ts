/**
 * Finds elements by id inside one part of the page, for modules that are
 * handed their own piece of the markup (a menu, the footer) rather than the
 * whole document. Missing ids are a markup bug, so it doesn't return null.
 */
export function partsOf(root: HTMLElement) {
  return <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
}
