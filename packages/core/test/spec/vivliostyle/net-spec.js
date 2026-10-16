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

import * as adapt_base from "../../../src/vivliostyle/base";
import * as adapt_net from "../../../src/vivliostyle/net";
import * as adapt_task from "../../../src/vivliostyle/task";
import * as adapt_xmldoc from "../../../src/vivliostyle/xml-doc";

describe("net", function () {
  describe("fetchFromURL", function () {
    it("fetches a data:text/html, URL and parses as an empty HTML document", async function () {
      var docStore = adapt_xmldoc.newXMLDocStore();

      var response = await adapt_net.fetchFromURL(
        "data:text/html,",
        adapt_net.FetchResponseType.DOCUMENT,
      );
      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/html");

      var docHolder = await adapt_xmldoc.parseXMLResource(response, docStore);
      expect(docHolder).not.toBeNull();
      expect(docHolder.document.documentElement.namespaceURI).toBe(
        adapt_base.NS.XHTML,
      );
      expect(docHolder.document.body).not.toBeNull();
    });

    it("resolves with the status instead of rejecting when the fetch fails", async function () {
      // Nothing listens on port 1: the request fails with a network error.
      var response = await adapt_net.fetchFromURL("http://127.0.0.1:1/none");
      expect(response.status).toBe(0);
      expect(response.responseText).toBeNull();
    });
  });
  describe("ResourceStore", function () {
    var url = "data:text/plain,hello";

    function newStore(parser) {
      return new adapt_net.ResourceStore(
        parser,
        adapt_net.FetchResponseType.TEXT,
      );
    }

    it("parses a resource once for concurrent loads and caches it", async function () {
      var parseCount = 0;
      var store = newStore(async function (response) {
        parseCount++;
        return response.responseText.toUpperCase();
      });

      var results = await Promise.all([store.load(url), store.load(url)]);
      expect(results).toEqual(["HELLO", "HELLO"]);
      expect(await store.load(url)).toBe("HELLO");
      expect(parseCount).toBe(1);
      expect(store.resources[url]).toBe("HELLO");
    });

    it("loadResult gives the loaded resource at once, to code that still uses Result", async function () {
      var store = newStore(async function (response) {
        return response.responseText;
      });
      await store.load(url);

      var seen = [];
      await new Promise(function (resolve) {
        adapt_task.start(function () {
          var frame = adapt_task.newFrame("caller");
          store.loadResult(url).then(function (v) {
            seen.push(v);
          });
          // The callback ran synchronously, before this line.
          expect(seen).toEqual(["hello"]);
          resolve();
          frame.finish(true);
          return frame.result();
        });
      });
    });

    it("loadResult waits for a resource that has not been loaded yet", async function () {
      var store = newStore(async function (response) {
        return response.responseText;
      });
      var result = await new Promise(function (resolve) {
        adapt_task.start(function () {
          var frame = adapt_task.newFrame("caller");
          store.loadResult(url).then(function (v) {
            resolve(v);
            frame.finish(true);
          });
          return frame.result();
        });
      });
      expect(result).toBe("hello");
    });

    it("rejects load when a required resource gets an HTTP error", async function () {
      var store = newStore(async function (response) {
        return response.responseText;
      });
      // The test server answers 404 for a path it does not serve.
      await expectAsync(
        store.load("/no-such-resource-for-the-test", true, "required resource"),
      ).toBeRejectedWithError(/^required resource \(404/);
      // A resource that is not required resolves, with what the parser made of
      // the failed response (nothing here).
      expect(await store.load("/no-such-resource-for-the-test-2")).toBeNull();
    });
  });
});
