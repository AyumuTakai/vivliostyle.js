/**
 * Copyright 2026 Vivliostyle Foundation
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview RubyRepeat - `-viv-ruby-repeat: hide-on-page`, which shows
 * the ruby of a word only at its first occurrence on each page.
 *
 * The ruby elements with the property are marked when their view elements are
 * made (`markRuby`), and the repeated ones are hidden when the page is laid
 * out (`hideRepeatedRuby`). They are hidden with `visibility: hidden`, so the
 * layout of the page does not change.
 */
import * as Base from "./base";

/** The attribute of the ruby elements to look at, with the scope ("page") */
export const RUBY_REPEAT_ATTR = "data-viv-ruby-repeat";
/** The attribute with the key of the word (see `rubyKey`) */
export const RUBY_KEY_ATTR = "data-viv-ruby-key";
/** The attribute of the ruby elements whose annotations are hidden */
export const RUBY_HIDDEN_ATTR = "data-viv-ruby-hidden";
/** An attribute of the source to give the key of the word explicitly */
const SOURCE_KEY_ATTR = "data-ruby-key";

const ANNOTATION_TAGS = new Set(["rt", "rtc"]);

function collectText(
  node: Node,
  parts: { base: string[]; annotation: string[] },
  inAnnotation: boolean,
): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      (inAnnotation ? parts.annotation : parts.base).push(
        child.textContent ?? "",
      );
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const name = (child as Element).localName;
      if (name !== "rp") {
        collectText(child, parts, inAnnotation || ANNOTATION_TAGS.has(name));
      }
    }
  }
}

/**
 * The key of the word of a ruby element of the source: the text of the base
 * and the text of the annotations, or the `data-ruby-key` attribute.
 */
export function rubyKey(source: Element): string {
  const explicit = source.getAttribute(SOURCE_KEY_ATTR);
  if (explicit) {
    return explicit;
  }
  const parts = { base: [] as string[], annotation: [] as string[] };
  collectText(source, parts, false);
  return `${parts.base.join("").trim()}\u0000${parts.annotation.join("").trim()}`;
}

/** Marks the view element of a ruby element with `-viv-ruby-repeat: hide-on-page`. */
export function markRuby(view: Element, source: Element): void {
  view.setAttribute(RUBY_REPEAT_ATTR, "page");
  view.setAttribute(RUBY_KEY_ATTR, rubyKey(source));
}

function sourceOffset(element: Element): number {
  const offset = Number.parseInt(
    element.getAttribute(Base.ELEMENT_OFFSET_ATTR) ?? "",
    10,
  );
  return Number.isNaN(offset) ? Number.MAX_SAFE_INTEGER : offset;
}

/**
 * Whether the ruby is shown in the page area. The ruby in the page margin
 * boxes, and in the running elements (which are kept hidden in the page area
 * with `position: fixed`, see `Vgen.ViewFactory`), are not.
 */
function isInPageArea(ruby: Element, container: Element): boolean {
  if (ruby.closest("[data-vivliostyle-page-margin-box]")) {
    return false;
  }
  for (
    let element = ruby.parentElement;
    element && element !== container;
    element = element.parentElement
  ) {
    const { style } = element as HTMLElement;
    if (style?.position === "fixed" || style?.visibility === "hidden") {
      return false;
    }
  }
  return true;
}

/**
 * Hides the annotations of the ruby elements of the page that repeat a word
 * that appears earlier on the page, in the order of the source. The ruby out
 * of the page area (see `isInPageArea`) is not counted and not hidden. The
 * marks of an earlier run are cleared first, as a page can be laid out again.
 */
export function hideRepeatedRuby(container: Element): void {
  for (const ruby of container.querySelectorAll(`[${RUBY_HIDDEN_ATTR}]`)) {
    ruby.removeAttribute(RUBY_HIDDEN_ATTR);
  }
  const rubies = [...container.querySelectorAll(`[${RUBY_REPEAT_ATTR}]`)]
    .filter((ruby) => isInPageArea(ruby, container))
    .map((ruby, index) => ({ ruby, index, offset: sourceOffset(ruby) }))
    // The elements of the page are in the order of the source, except the
    // floats and the footnotes, which are in their own areas
    .sort((a, b) => a.offset - b.offset || a.index - b.index);
  const seen = new Set<string>();
  for (const { ruby } of rubies) {
    const key = ruby.getAttribute(RUBY_KEY_ATTR) ?? "";
    if (seen.has(key)) {
      ruby.setAttribute(RUBY_HIDDEN_ATTR, "");
    } else {
      seen.add(key);
    }
  }
}
