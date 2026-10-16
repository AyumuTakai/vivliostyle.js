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
import { runLegacy } from "../../../src/vivliostyle/task-bridge";
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

      // parseXMLResource is still a legacy (Task-based) function.
      var docHolder = await runLegacy(function () {
        return adapt_xmldoc.parseXMLResource(response, docStore);
      });
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
});
