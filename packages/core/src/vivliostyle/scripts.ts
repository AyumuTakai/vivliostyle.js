/**
 * Copyright 2022 Vivliostyle Foundation
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
 * @fileoverview Scripts - Supports JavaScript in source document.
 */
import * as CssCascade from "./css-cascade";
import * as CssStyler from "./css-styler";
import * as Net from "./net";
import * as Logging from "./logging";
import * as TaskUtil from "./task-util";

/**
 * Enable or disable JavaScript in html support
 */
export let allowScripts = true;
export function setAllowScripts(value: boolean): void {
  allowScripts = value;
}

const deferredScripts: HTMLScriptElement[] = [];

function sameScripts(s1: HTMLScriptElement, s2: HTMLScriptElement): boolean {
  return (
    s1 === s2 ||
    (s1.src || s2.src ? s1.src === s2.src : s1.textContent === s2.textContent)
  );
}

function getScriptsInOrNearHead(document: Document): HTMLScriptElement[] {
  return Array.from(
    document.querySelectorAll<HTMLScriptElement>(
      "head > script, body > script:not(:not(script, link, style) ~ *)",
    ),
  );
}

export async function loadScript(
  srcScriptElem: HTMLScriptElement,
  window: Window,
  flags?: { inHead?: boolean; atEnd?: boolean; forceDefer?: boolean },
): Promise<boolean> {
  if (!allowScripts) {
    return false;
  }
  if (
    !flags?.inHead &&
    !flags?.atEnd &&
    getScriptsInOrNearHead(srcScriptElem.ownerDocument).includes(srcScriptElem)
  ) {
    // The script elements at beginning of body have already been processed.
    return false;
  }

  const scriptContent = srcScriptElem.textContent;
  const src = srcScriptElem.src;
  const isModule = srcScriptElem.type === "module";

  // Special handling for MathJax
  // NOTE: We support MathJax 2 only for now.
  const isMathJax = src && src.includes("/MathJax.js");
  if (isMathJax) {
    if (window.document.head.querySelector("script[src*='/MathJax.js']")) {
      // Ignore if MathJax is already loaded
      return true;
    }
    if (!window["MathJax"]) {
      // mathjax-config.js
      window["MathJax"] = {
        MathML: {
          extensions: ["content-mathml.js"],
        },
        showProcessingMessages: false,
        messageStyle: "none",
        skipStartupTypeset: true,
        CommonHTML: {
          linebreaks: {
            automatic: true,
          },
        },
        "fast-preview": {
          disabled: true,
        },
        AuthorInit: function () {
          window["MathJax"].Hub.processSectionDelay = 0;
        },
      };
    }
  }

  const async = (isModule || src) && srcScriptElem.async && !isMathJax;
  const defer =
    ((isModule && !async) || (src && srcScriptElem.defer)) && !isMathJax;
  const needDefer = !flags?.atEnd && (flags?.forceDefer || defer || async);

  if (!hasScripts(window)) {
    // `window.onload = startViewer`, which was set by vivliostyle-viewer,
    // has to be unset to prevent `startViewer` restarting because of
    // `window.dispatchEvent(new Event("load"))` in `loadScriptsAtEnd()`.
    window.onload = null;
  }

  if (needDefer) {
    if (!deferredScripts.some((s) => sameScripts(s, srcScriptElem))) {
      deferredScripts.push(srcScriptElem);
    }
    return true;
  }

  for (const s of window.document.head.getElementsByTagName("script")) {
    if (
      s.hasAttribute("data-vivliostyle-scripting") &&
      sameScripts(s, srcScriptElem)
    ) {
      // If same script is already loaded, remove the already loaded one before load the new one.
      window.document.head.removeChild(s);
    }
  }

  const scriptElem = window.document.createElement("script");
  scriptElem.textContent = scriptContent;
  if (src) {
    scriptElem.src = src;
  }
  scriptElem.async = !!async;
  scriptElem.defer = !!defer;
  scriptElem.setAttribute("data-vivliostyle-scripting", "true");

  for (const attr of srcScriptElem.attributes) {
    if (!["src", "async", "defer"].includes(attr.name)) {
      scriptElem.setAttribute(attr.name, attr.value);
    }
  }
  Logging.logger.debug("script:", src);
  if (!src) {
    window.document.head.appendChild(scriptElem);
    return true;
  } else {
    const fetcher = Net.loadElement(scriptElem);
    window.document.head.appendChild(scriptElem);
    await TaskUtil.waitForFetchers([fetcher]);
    return true;
  }
}

function getAllFontFamilyList(
  srcDocument: Document,
  styler: CssStyler.Styler,
): string {
  const fontFamilySet = {};
  const findFontFamilyInStyle = (style: any): void => {
    const fontFamily = style["font-family"]?.value;
    if (fontFamily) {
      if (fontFamily.values) {
        for (const family1 of fontFamily.values) {
          fontFamilySet[family1.stringValue()] = true;
        }
      } else {
        fontFamilySet[fontFamily.stringValue()] = true;
      }
    }
    const marginBoxes = style["_marginBoxes"];
    if (marginBoxes) {
      for (const marginBoxStyle of Object.values(marginBoxes)) {
        findFontFamilyInStyle(marginBoxStyle);
      }
    }
  };
  const findAllFontFamily = (arg: any): void => {
    if (arg instanceof CssCascade.ApplyRuleAction) {
      findFontFamilyInStyle(arg.style);
    } else if (arg instanceof CssCascade.CascadeAction || Array.isArray(arg)) {
      for (const v of Object.values(arg)) {
        findAllFontFamily(v);
      }
    }
  };
  // Find all font-family values in stylesheets.
  for (const obj of Object.values(styler.cascade.code)) {
    for (const arg of Object.values(obj ?? {})) {
      findAllFontFamily(arg);
    }
  }
  // Find all font-family values in inline style.
  for (const elem of srcDocument.querySelectorAll("[style]")) {
    if ((elem as HTMLElement).style?.fontFamily) {
      fontFamilySet[(elem as HTMLElement).style.fontFamily] = true;
    }
  }
  return Object.keys(fontFamilySet).join(",");
}

function prepareTextContentForWebFonts(
  srcDocument: Document,
  window: Window,
  styler: CssStyler.Styler,
): HTMLElement {
  const textContentDiv: HTMLElement =
    window.document.querySelector("[data-vivliostyle-textcontent]") ??
    window.document.createElement("div");
  textContentDiv.style.position = "fixed";
  textContentDiv.style.fontSize = "0";
  textContentDiv.setAttribute("data-vivliostyle-textcontent", "true");
  textContentDiv.setAttribute("aria-hidden", "true");
  textContentDiv.style.fontFamily = getAllFontFamilyList(srcDocument, styler);
  textContentDiv.textContent = srcDocument.documentElement.textContent;
  window.document.body.appendChild(textContentDiv);
  return textContentDiv;
}

export async function loadScriptsInHead(
  srcDocument: Document,
  window: Window,
  styler: CssStyler.Styler,
): Promise<boolean> {
  if (!allowScripts) {
    return false;
  }
  // Process script elements in head and also beginning of body
  const srcScripts: HTMLScriptElement[] = getScriptsInOrNearHead(srcDocument);
  if (srcScripts.length === 0) {
    return false;
  }
  const needPrepareForWebFonts = srcScripts.some(
    (s) => !(s.async || s.defer || s.type === "module"),
  );

  // Web fonts needs text content of the document
  const textContentDiv = needPrepareForWebFonts
    ? prepareTextContentForWebFonts(srcDocument, window, styler)
    : null;
  const fonts = window.document.fonts; // FontFaceSet
  const savedDollar = window["$"];
  let forceDefer = false;
  for (;;) {
    if (srcScripts.length === 0) {
      if (!needPrepareForWebFonts) {
        break;
      }
      await TaskUtil.sleep(20);
      if (
        fonts.status === "loading" ||
        // for Typekit Web Font Loader (Adobe Fonts)
        window.document.documentElement.classList.contains("wf-loading") ||
        // For DynaFont
        // FIXME: checking the global variable `ret` set in https://dfo.dynacw.co.jp/JSDynaFont/DynaFont.js
        // would be not very good, because it seems to have been made global by mistake.
        (window["FontJSON"]?.Font &&
          window["ret"]?.readyState &&
          window["ret"].readyState < 4)
      ) {
        continue;
      }
      break;
    }
    const srcScriptElem = srcScripts.shift();
    await loadScript(srcScriptElem, window, {
      inHead: true,
      forceDefer,
    });
    if (!forceDefer && window["$"] !== savedDollar) {
      // jQuery `$(…)` does not work before document is loaded, so need to defer
      deferredScripts.push(srcScriptElem);
      forceDefer = true;
    }
    if (srcScripts.length === 0) {
      if (needPrepareForWebFonts) {
        // Some web font loaders (DynaFont, FONTPLUS) need DOMContentLoaded event
        Logging.logger.debug("dispatchEvent: DOMContentLoaded (document)");
        window.document.dispatchEvent(new Event("DOMContentLoaded"));
      }
    }
  }
  if (textContentDiv) {
    textContentDiv.remove();
  }
  return true;
}

export async function loadScriptsAtEnd(window: Window): Promise<boolean> {
  if (!allowScripts) {
    return false;
  }
  while (deferredScripts.length > 0) {
    await loadScript(deferredScripts.shift(), window, {
      atEnd: true,
    });
  }
  Logging.logger.debug("dispatchEvent: DOMContentLoaded (window)");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  Logging.logger.debug("dispatchEvent: load (window)");
  window.dispatchEvent(new Event("load"));
  return true;
}

export function hasScripts(window: Window) {
  if (!allowScripts) {
    return false;
  }
  return (
    deferredScripts.length > 0 ||
    !!window.document.head.querySelector("script[data-vivliostyle-scripting]")
  );
}
