/**
 * The display's DOM vocabulary, as a contract.
 *
 * Three claims are worth pinning, because the whole framework-free shell rests
 * on them: attributes are omitted rather than stringified when they are absent,
 * writes happen only on CHANGE (a panel that repaints an unchanged string once a
 * second for a fortnight is a layout thrash nobody is watching), and a `slot`
 * holds its POSITION whether or not it currently holds a node — which is what
 * keeps the stage's z-order stable as cards come and go.
 */

import { describe, expect, it } from 'vitest';

import { el, setAttr, setClass, setText, slot } from './dom';

describe('el', () => {
  it('sets attributes, skipping the absent ones', () => {
    const node = el('div', {
      class: 'kh-card',
      'data-n': 3,
      hidden: true,
      title: null,
      lang: undefined,
      draggable: false,
    });
    expect(node.getAttribute('class')).toBe('kh-card');
    expect(node.getAttribute('data-n')).toBe('3');
    expect(node.getAttribute('hidden')).toBe('');
    expect(node.hasAttribute('title')).toBe(false);
    expect(node.hasAttribute('lang')).toBe(false);
    expect(node.hasAttribute('draggable')).toBe(false);
  });

  it('takes a string child as text and an array as nodes', () => {
    expect(el('p', undefined, 'hello').textContent).toBe('hello');
    const list = el('div', undefined, [el('span', undefined, 'a'), null, false, 'b']);
    expect(list.childNodes.length).toBe(2);
    expect(list.textContent).toBe('ab');
  });

  it('never sets an event handler or an href by itself', () => {
    // Invariant I1's shape, in the helper: nothing here can navigate, because
    // nothing here knows how to.
    const node = el('div', { class: 'kh-stage' });
    expect(node.querySelectorAll('a')).toHaveLength(0);
    expect(node.outerHTML).toBe('<div class="kh-stage"></div>');
  });
});

describe('setText / setAttr / setClass', () => {
  it('writes only when the value differs', () => {
    const node = el('div');
    setText(node, 'one');
    const first = node.firstChild;
    setText(node, 'one');
    expect(node.firstChild).toBe(first);
    setText(node, 'two');
    expect(node.textContent).toBe('two');
  });

  it('removes an attribute on null and leaves an absent one alone', () => {
    const node = el('div', { 'data-shape': 'circle' });
    setAttr(node, 'data-shape', 'circle');
    expect(node.getAttribute('data-shape')).toBe('circle');
    setAttr(node, 'data-shape', 'square');
    expect(node.getAttribute('data-shape')).toBe('square');
    setAttr(node, 'data-shape', null);
    expect(node.hasAttribute('data-shape')).toBe(false);
    setAttr(node, 'data-shape', null);
    expect(node.hasAttribute('data-shape')).toBe(false);
  });

  it('writes the whole class attribute', () => {
    const node = el('div', { class: 'kh-stage' });
    setClass(node, 'kh-stage kh-stage--circle');
    expect(node.className).toBe('kh-stage kh-stage--circle');
  });
});

describe('slot', () => {
  it('keeps its position in the parent regardless of what it holds', () => {
    const parent = el('div');
    const first = slot(parent);
    const second = slot(parent);

    second.set(el('p', { class: 'b' }));
    expect([...parent.children].map((c) => c.className)).toEqual(['b']);

    // `first` was created earlier, so its content lands BEFORE `b` even though
    // it arrived later — the ordering the JSX used to get for free.
    first.set(el('p', { class: 'a' }));
    expect([...parent.children].map((c) => c.className)).toEqual(['a', 'b']);

    first.set(null);
    expect([...parent.children].map((c) => c.className)).toEqual(['b']);

    first.set(el('p', { class: 'a2' }));
    expect([...parent.children].map((c) => c.className)).toEqual(['a2', 'b']);
  });

  it('replaces rather than accumulates, and disposes cleanly', () => {
    const parent = el('div');
    const only = slot(parent);
    only.set(el('p'));
    only.set(el('span'));
    expect(parent.children).toHaveLength(1);
    expect(parent.firstElementChild?.tagName).toBe('SPAN');
    only.dispose();
    expect(parent.childNodes).toHaveLength(0);
  });
});
