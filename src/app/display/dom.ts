/**
 * The display's DOM vocabulary — about eighty lines, no framework.
 *
 * The LCD's shell is a dozen nodes that change a handful of times per session:
 * a stage, a compositor root, and four advisory cards that are either there or
 * not. That is not a rendering problem, and W9 stopped paying 57.5 kB gzip of
 * React to solve it. What the shell actually needs is here:
 *
 *   `el`     build a node in one expression, so the shell reads like the JSX it
 *            replaces rather than like fifteen lines of `createElement`;
 *   `setText`/`setAttr`/`setClass`  write only on CHANGE, because the debug
 *            overlay and the diagnostics panel rewrite the same fields once a
 *            second for weeks and an unconditional write dirties layout;
 *   `slot`   a fixed position in a parent that holds zero or one node, which is
 *            what `{cond && <Card/>}` was doing — the anchor keeps DOM ORDER
 *            (and therefore z-order) stable no matter which cards come and go.
 *
 * There is no diffing and no virtual DOM: every caller here knows exactly which
 * node it owns. Nothing in this file allocates on the frame path — the
 * compositor (`src/render/LayerHost.ts`) owns per-frame work and never calls in
 * here (invariant I4).
 */

/**
 * `false`, `null` and `undefined` all mean "omit the attribute", so a caller can
 * write a conditional inline; `true` sets it to the empty string.
 */
export type DomAttrs = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type DomChild = Node | string | null | undefined | false;

/**
 * One element, its attributes and its children.
 *
 * `class` is spelled the way HTML spells it, not the way React does: nothing
 * here is a component prop, so there is no reason for the shell's markup to
 * disagree with the stylesheet it is styled by.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: DomAttrs,
  children?: readonly DomChild[] | string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs !== undefined) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (typeof children === 'string') {
    node.textContent = children;
  } else if (children !== undefined) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
  }
  return node;
}

/** Write `textContent` only when it actually differs. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Write (or remove, on `null`) an attribute only when it actually differs. */
export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/** Write the whole `class` attribute only when it actually differs. */
export function setClass(node: Element, value: string): void {
  setAttr(node, 'class', value);
}

/**
 * A fixed position in `parent` holding at most one node.
 *
 * The anchor is an empty comment appended when the slot is created, so slots
 * occupy their parent in CREATION order and a card that appears later still
 * lands in the same place — which is what keeps the stage's z-order identical
 * to the order the JSX used to declare.
 */
export interface Slot {
  /** Replace whatever is in the slot. `null` empties it. */
  set(node: ChildNode | null): void;
  /** Remove the slot's content and its anchor. */
  dispose(): void;
}

export function slot(parent: Node): Slot {
  const anchor = document.createComment('');
  parent.appendChild(anchor);
  let current: ChildNode | null = null;
  return {
    set(node) {
      if (node === current) return;
      current?.remove();
      current = node;
      if (node !== null) parent.insertBefore(node, anchor);
    },
    dispose() {
      current?.remove();
      current = null;
      anchor.remove();
    },
  };
}
