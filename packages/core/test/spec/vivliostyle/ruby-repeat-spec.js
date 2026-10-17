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
 */

import * as RubyRepeat from "../../../src/vivliostyle/ruby-repeat";

describe("ruby-repeat", function () {
  function element(html) {
    var template = document.createElement("template");
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  }

  describe("rubyKey", function () {
    it("is made of the base and the annotation", function () {
      expect(
        RubyRepeat.rubyKey(
          element("<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>"),
        ),
      ).toBe("漢字\u0000かんじ");
      expect(
        RubyRepeat.rubyKey(
          element("<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>"),
        ),
      ).toBe("漢字\u0000かんじ");
      expect(
        RubyRepeat.rubyKey(
          element("<ruby><rb>生</rb><rtc><rt>せい</rt></rtc></ruby>"),
        ),
      ).toBe("生\u0000せい");
    });

    it("is the data-ruby-key attribute if it is given", function () {
      expect(
        RubyRepeat.rubyKey(
          element(
            '<ruby data-ruby-key="kanji">漢<rt>かん</rt>字<rt>じ</rt></ruby>',
          ),
        ),
      ).toBe("kanji");
    });
  });

  describe("hideRepeatedRuby", function () {
    /** A page with the ruby elements: [base, annotation, offset in the source, where] */
    function page(rubies) {
      var container = document.createElement("div");
      container.innerHTML =
        "<div data-vivliostyle-page-area></div>" +
        "<div data-vivliostyle-page-margin-box></div>" +
        '<div style="position: fixed; visibility: hidden"></div>';
      var areas = {
        area: container.children[0],
        margin: container.children[1],
        running: container.children[2],
      };
      var elements = rubies.map(function (ruby) {
        var view = element(
          "<ruby>" + ruby[0] + "<rt>" + ruby[1] + "</rt></ruby>",
        );
        RubyRepeat.markRuby(view, view);
        view.setAttribute("data-adapt-eloff", String(ruby[2]));
        areas[ruby[3] || "area"].appendChild(view);
        return view;
      });
      return { container: container, elements: elements };
    }

    function hidden(elements) {
      return elements.map(function (ruby) {
        return ruby.hasAttribute(RubyRepeat.RUBY_HIDDEN_ATTR);
      });
    }

    it("hides the ruby of the words that appear earlier on the page", function () {
      var p = page([
        ["漢字", "かんじ", 10],
        ["生", "なま", 20],
        ["漢字", "かんじ", 30],
        ["生", "せい", 40],
        ["生", "なま", 50],
      ]);
      RubyRepeat.hideRepeatedRuby(p.container);
      expect(hidden(p.elements)).toEqual([false, false, true, false, true]);
    });

    it("follows the order of the source, not of the elements", function () {
      // A footnote that comes later in the source is placed earlier
      var p = page([
        ["漢字", "かんじ", 90],
        ["漢字", "かんじ", 10],
      ]);
      RubyRepeat.hideRepeatedRuby(p.container);
      expect(hidden(p.elements)).toEqual([true, false]);
    });

    it("does not count nor hide the ruby out of the page area", function () {
      var p = page([
        ["漢字", "かんじ", 1, "running"],
        ["漢字", "かんじ", 2, "margin"],
        ["漢字", "かんじ", 10],
        ["漢字", "かんじ", 20],
      ]);
      RubyRepeat.hideRepeatedRuby(p.container);
      expect(hidden(p.elements)).toEqual([false, false, false, true]);
    });

    it("clears the marks of an earlier run", function () {
      var p = page([
        ["漢字", "かんじ", 10],
        ["漢字", "かんじ", 20],
      ]);
      RubyRepeat.hideRepeatedRuby(p.container);
      // The page is laid out again without the first one
      p.elements[0].remove();
      RubyRepeat.hideRepeatedRuby(p.container);
      expect(hidden(p.elements)).toEqual([false, false]);
    });
  });
});
