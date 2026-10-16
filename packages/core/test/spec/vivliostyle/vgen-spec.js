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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js. If not, see <http://www.gnu.org/licenses/>.
 */

import * as CssCascade from "../../../src/vivliostyle/css-cascade";
import * as CssParser from "../../../src/vivliostyle/css-parser";
import * as CssTokenizer from "../../../src/vivliostyle/css-tokenizer";
import * as Diff from "../../../src/vivliostyle/diff";
import * as Exprs from "../../../src/vivliostyle/exprs";
import * as Plugin from "../../../src/vivliostyle/plugin";
import * as Vgen from "../../../src/vivliostyle/vgen";

describe("vgen", function () {
  describe("preprocessTextContent", function () {
    const hooks = [];
    afterEach(function () {
      while (hooks.length) {
        Plugin.removeHook(Plugin.HOOKS.PREPROCESS_TEXT_CONTENT, hooks.pop());
      }
    });
    function register(hook) {
      hooks.push(hook);
      Plugin.registerHook(Plugin.HOOKS.PREPROCESS_TEXT_CONTENT, hook);
    }
    function createNodeContext(text) {
      return {
        sourceNode: { textContent: text },
        preprocessedTextContent: null,
      };
    }

    it("applies the hooks in order, whether they return a string or a Promise", async function () {
      const factory = Object.create(Vgen.ViewFactory.prototype);
      register((nodeContext, text) => text + "A");
      register(async (nodeContext, text) => text + "B");
      register(
        (nodeContext, text) =>
          new Promise((resolve) => setTimeout(() => resolve(text + "C"), 5)),
      );
      const nodeContext = createNodeContext("x");

      const changes = await factory.preprocessTextContent(nodeContext);

      expect(Diff.restoreNewText(changes)).toBe("xABC");
      expect(nodeContext.preprocessedTextContent).toBe(changes);
    });

    it("returns the text that was already preprocessed", async function () {
      const factory = Object.create(Vgen.ViewFactory.prototype);
      const hook = jasmine.createSpy("hook").and.returnValue("z");
      register(hook);
      const nodeContext = createNodeContext("y");
      nodeContext.preprocessedTextContent = [];

      const changes = await factory.preprocessTextContent(nodeContext);

      expect(changes).toBe(nodeContext.preprocessedTextContent);
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe("inheritFromSourceParent", function () {
    function inherit(fontSize, lineHeight) {
      const scope = new Exprs.LexicalScope(null);
      const context = new Exprs.Context(scope, 800, 600, 16, 20);
      const value = (text) =>
        new CssCascade.CascadeValue(
          CssParser.parseValue(
            scope,
            new CssTokenizer.Tokenizer(text, null),
            "",
          ),
          1,
        );
      const root = document.createElement("div");
      const parent = root.appendChild(document.createElement("p"));
      const footnote = parent.appendChild(document.createElement("span"));
      const currentStyle = {
        "font-size": value(fontSize),
        "line-height": value(lineHeight),
      };
      const styles = new Map([
        [root, { "font-size": value("16px"), "line-height": value("40px") }],
        [parent, { "font-size": value("20px"), "line-height": value("1.5") }],
        [footnote, currentStyle],
      ]);
      const factory = {
        context,
        regionIds: [],
        isFootnote: true,
        styler: { getStyle: (element) => styles.get(element) },
      };
      return Vgen.ViewFactory.prototype.inheritFromSourceParent.call(
        factory,
        { sourceNode: footnote, shadowContext: null, parent: null },
        currentStyle,
      ).elementStyle;
    }

    it("resolves an lh font size before applying its own line height", function () {
      const style = inherit("1lh", "1");
      expect(style["font-size"].value.toString()).toBe("30px");
      expect(style["line-height"].value.toString()).toBe("1");
    });

    it("resolves both lh declarations against the source parent", function () {
      const style = inherit("1lh", "2lh");
      expect(style["font-size"].value.toString()).toBe("30px");
      expect(style["line-height"].value.toString()).toBe("60px");
    });

    it("keeps the source parent line height for a font size calculation", function () {
      const style = inherit("calc(1lh + 2px)", "1");
      const fontSize = CssCascade.evaluateCSSToCSS(
        new Exprs.Context(new Exprs.LexicalScope(null), 800, 600, 16, 20),
        style["font-size"].value,
        "font-size",
      );
      expect(fontSize.toString()).toBe("32px");
      expect(style["line-height"].value.toString()).toBe("1");
    });
  });
});
