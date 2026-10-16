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
import * as adapt_scripts from "../../../src/vivliostyle/scripts";

describe("scripts", function () {
  var iframe;
  var win;

  beforeEach(function () {
    adapt_scripts.setAllowScripts(true);
    iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    win = iframe.contentWindow;
  });

  afterEach(function () {
    adapt_scripts.setAllowScripts(true);
    iframe.remove();
  });

  // A script element that is not in the document (it is not processed as a head script).
  // Scripts created with createElement are "async" by default, which would make
  // loadScript defer them until the end, so async is turned off.
  function newScript(attrs, text) {
    var script = document.createElement("script");
    script.async = false;
    Object.keys(attrs || {}).forEach(function (k) {
      script.setAttribute(k, attrs[k]);
    });
    if (text) {
      script.textContent = text;
    }
    return script;
  }

  describe("loadScript", function () {
    it("does nothing when scripts are not allowed", async function () {
      adapt_scripts.setAllowScripts(false);
      var result = await adapt_scripts.loadScript(
        newScript({}, "window.__ran = 1;"),
        win,
      );
      expect(result).toBe(false);
      expect(win.__ran).toBeUndefined();
    });

    it("runs an inline script", async function () {
      var result = await adapt_scripts.loadScript(
        newScript({}, "window.__ran = 1;"),
        win,
      );
      expect(result).toBe(true);
      expect(win.__ran).toBe(1);
    });

    it("waits until an external script has loaded", async function () {
      var result = await adapt_scripts.loadScript(
        newScript({
          src:
            "data:text/javascript," + encodeURIComponent("window.__ext = 2;"),
        }),
        win,
      );
      expect(result).toBe(true);
      expect(win.__ext).toBe(2);
    });
  });

  describe("loadScriptsAtEnd", function () {
    it("runs the deferred scripts, then dispatches DOMContentLoaded and load", async function () {
      var events = [];
      win.addEventListener("DOMContentLoaded", function () {
        events.push("DOMContentLoaded:" + win.__deferred);
      });
      win.addEventListener("load", function () {
        events.push("load:" + win.__deferred);
      });
      // A deferred script is not run by loadScript, but kept until the end.
      var deferred = newScript({
        src:
          "data:text/javascript," +
          encodeURIComponent("window.__deferred = 3;"),
        defer: "",
      });
      expect(await adapt_scripts.loadScript(deferred, win)).toBe(true);
      expect(win.__deferred).toBeUndefined();
      expect(adapt_scripts.hasScripts(win)).toBe(true);

      expect(await adapt_scripts.loadScriptsAtEnd(win)).toBe(true);
      expect(win.__deferred).toBe(3);
      expect(events).toEqual(["DOMContentLoaded:3", "load:3"]);
    });

    it("does nothing when scripts are not allowed", async function () {
      adapt_scripts.setAllowScripts(false);
      expect(await adapt_scripts.loadScriptsAtEnd(win)).toBe(false);
    });
  });
});
