/**
 * Copyright 2017 Daishinsha Inc.
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

import * as adapt_epub from "../../../src/vivliostyle/epub";
import * as adapt_logging from "../../../src/vivliostyle/logging";
import * as adapt_viewer from "../../../src/vivliostyle/adaptive-viewer";
import * as adapt_vtree from "../../../src/vivliostyle/vtree";
import * as adapt_xmldoc from "../../../src/vivliostyle/xml-doc";
import * as vivliostyle_plugin from "../../../src/vivliostyle/plugin";

describe("epub", function () {
  describe("AdaptiveViewer page replacement", function () {
    function createViewer(showCurrent) {
      var viewer = Object.create(adapt_viewer.AdaptiveViewer.prototype);
      viewer.currentPage = { name: "current" };
      viewer.currentSpread = null;
      viewer.showCurrent = showCurrent;
      return viewer;
    }

    it("shows the new page when the current page is replaced", function () {
      var shown = [];
      var viewer = createViewer(function (page) {
        shown.push(page);
        return Promise.resolve(null);
      });
      var newPage = { name: "new" };
      viewer.pageReplacedListener({ target: viewer.currentPage, newPage });
      expect(shown).toEqual([newPage]);
    });

    it("ignores the replacement of a page that is not displayed", function () {
      var shown = [];
      var viewer = createViewer(function (page) {
        shown.push(page);
        return Promise.resolve(null);
      });
      viewer.pageReplacedListener({ target: {}, newPage: {} });
      expect(shown).toEqual([]);
    });

    it("shows the new page when a page of the spread is replaced", function () {
      var shown = [];
      var viewer = createViewer(function (page) {
        shown.push(page);
        return Promise.resolve(null);
      });
      var right = {};
      viewer.currentSpread = { left: null, right };
      var newPage = {};
      viewer.pageReplacedListener({ target: right, newPage });
      expect(shown).toEqual([newPage]);
    });

    it("logs a failure to show the page instead of leaving a rejected Promise", async function () {
      var error = new Error("cannot show");
      var viewer = createViewer(function () {
        return Promise.reject(error);
      });
      var unhandled = [];
      var onUnhandled = function (event) {
        unhandled.push(event.reason);
        event.preventDefault();
      };
      window.addEventListener("unhandledrejection", onUnhandled);
      spyOn(adapt_logging.logger, "error");
      try {
        viewer.pageReplacedListener({
          target: viewer.currentPage,
          newPage: {},
        });
        // let the rejection (if it were not handled) be reported
        await new Promise(function (resolve) {
          setTimeout(resolve, 50);
        });
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
      expect(unhandled).toEqual([]);
      expect(adapt_logging.logger.error).toHaveBeenCalledWith(
        error,
        jasmine.any(String),
      );
    });
  });

  describe("AdaptiveViewer page sizes", function () {
    it("removes stale page sizes after pagination shrinks", function () {
      var viewer = Object.create(adapt_viewer.AdaptiveViewer.prototype);
      viewer.pageSizes = [
        { width: 100, height: 100 },
        { width: 120, height: 110 },
        { width: 1000, height: 1000 },
      ];
      viewer.pageRuleStyleElement = document.createElement("style");
      viewer.pageRuleStyleElement.textContent = "stale";
      viewer.pageSheetSizeAlreadySet = true;
      viewer.pixelRatio = 1;

      viewer.truncatePageSizes(2);

      expect(viewer.pageSizes).toEqual([
        { width: 100, height: 100 },
        { width: 120, height: 110 },
      ]);
      expect(viewer.pageRuleStyleElement.textContent).toContain(
        "size: 90pt 83pt",
      );
      expect(viewer.pageRuleStyleElement.textContent).not.toContain("750pt");
    });

    it("keeps a live sparse page-size slot created by startPage", function () {
      var viewer = Object.create(adapt_viewer.AdaptiveViewer.prototype);
      viewer.pageSizes = [];
      viewer.pageSizes[4] = { width: 120, height: 110 };
      viewer.pageSizes[5] = { width: 1000, height: 1000 };
      viewer.pageRuleStyleElement = document.createElement("style");
      viewer.pageRuleStyleElement.textContent = "stale";
      viewer.pageSheetSizeAlreadySet = true;
      viewer.pixelRatio = 1;

      viewer.truncatePageSizes(5);

      expect(viewer.pageSizes.length).toBe(5);
      expect(viewer.pageSizes[4]).toEqual({ width: 120, height: 110 });
      expect(viewer.pageRuleStyleElement.textContent).toContain(
        "size: 90pt 83pt",
      );
      expect(viewer.pageRuleStyleElement.textContent).not.toContain("750pt");
    });

    it("refreshes page rules after a same-length page-size rebuild", function () {
      var viewer = Object.create(adapt_viewer.AdaptiveViewer.prototype);
      viewer.pageSizes = [
        { width: 100, height: 100 },
        { width: 100, height: 100 },
      ];
      viewer.pageRuleStyleElement = document.createElement("style");
      viewer.pageRuleStyleElement.textContent =
        "@page {size: 750pt 750pt; margin: 0;}";
      viewer.pageSheetSizeAlreadySet = true;
      viewer.pixelRatio = 1;

      viewer.truncatePageSizes(2);

      expect(viewer.pageSizes.length).toBe(2);
      expect(viewer.pageRuleStyleElement.textContent).toContain(
        "size: 75pt 75pt",
      );
      expect(viewer.pageRuleStyleElement.textContent).not.toContain("750pt");
    });
  });

  describe("EPUBDocStore", function () {
    describe("loadPubDoc", function () {
      it("skips HEAD and treats data: URLs as a Web Publication primary entry", async function () {
        var store = new adapt_epub.EPUBDocStore();
        var opf = {};
        spyOn(store, "loadWebPub").and.returnValue(Promise.resolve(opf));

        var result = await store.loadPubDoc("data:text/html,");
        expect(store.loadWebPub).toHaveBeenCalledWith("data:text/html,");
        expect(result).toBe(opf);
      });

      it("skips HEAD and treats .svg URLs as a Web Publication primary entry", async function () {
        var store = new adapt_epub.EPUBDocStore();
        var url =
          "https://raw.githack.com/web-platform-tests/wpt/master/svg/styling/css-var-on-length-attributes-02.svg";
        var opf = {};
        spyOn(store, "loadWebPub").and.returnValue(Promise.resolve(opf));

        var result = await store.loadPubDoc(url);
        expect(store.loadWebPub).toHaveBeenCalledWith(url);
        expect(result).toBe(opf);
      });

      it("skips HEAD and treats blob: URLs as a Web Publication primary entry", async function () {
        var store = new adapt_epub.EPUBDocStore();
        var url =
          "blob:http://localhost:3000/12345678-1234-1234-1234-123456789abc";
        var opf = {};
        spyOn(store, "loadWebPub").and.returnValue(Promise.resolve(opf));

        var result = await store.loadPubDoc(url);
        expect(store.loadWebPub).toHaveBeenCalledWith(url);
        expect(result).toBe(opf);
      });
    });
  });

  describe("OPFDoc", function () {
    describe("fromWebPubManifest", function () {
      it("creates a primary entry for data: URL documents", async function () {
        var store = new adapt_epub.EPUBDocStore();
        var doc = new DOMParser().parseFromString(
          "<html xmlns='http://www.w3.org/1999/xhtml'><head><title>Blank</title></head><body></body></html>",
          "text/html",
        );

        var opf = await adapt_epub.OPFDoc.fromWebPubManifest(
          store,
          "data:text/html,",
          {},
          doc,
        );
        expect(opf.items.length).toBe(1);
        expect(opf.spine.length).toBe(1);
        expect(opf.items[0].src).toBe("data:text/html,");
      });

      it("creates a primary entry when the publication URL is the root document", async function () {
        var store = new adapt_epub.EPUBDocStore();
        var doc = new DOMParser().parseFromString(
          "<html xmlns='http://www.w3.org/1999/xhtml'><head><title>Root</title></head><body></body></html>",
          "text/html",
        );

        var opf = await adapt_epub.OPFDoc.fromWebPubManifest(
          store,
          "https://example.com/webpub/",
          {},
          doc,
        );
        expect(opf.items.length).toBe(1);
        expect(opf.spine.length).toBe(1);
        expect(opf.items[0].src).toBe("https://example.com/webpub/");
      });

      ["%23", "%3F", "%3A"].forEach(function (encodedCharacter) {
        it(
          "preserves " + encodedCharacter + " in the primary entry filename",
          async function () {
            var store = new adapt_epub.EPUBDocStore();
            var doc = new DOMParser().parseFromString(
              "<html xmlns='http://www.w3.org/1999/xhtml'><head><title>Reserved character</title></head><body></body></html>",
              "text/html",
            );
            var url =
              "https://example.com/book/file" + encodedCharacter + "name.html";

            var opf = await adapt_epub.OPFDoc.fromWebPubManifest(
              store,
              url,
              {},
              doc,
            );
            expect(opf.spine.length).toBe(1);
            expect(opf.spine[0].src).toBe(url);
          },
        );
      });
    });

    describe("epage and fragment resolution", function () {
      // An OPFDoc of two chapters whose documents come from a fake store.
      async function createOpfDoc(totalOffsets, load) {
        var store = {
          load:
            load ||
            async function (url) {
              var index = url.endsWith("b.html") ? 1 : 0;
              var doc = new DOMParser().parseFromString(
                "<html xmlns='http://www.w3.org/1999/xhtml'><head><title>t</title></head><body><p id='p'>xxxxxxxxxx</p></body></html>",
                "text/html",
              );
              var holder = new adapt_xmldoc.XMLDocHolder(null, url, doc);
              // The fake documents report the given total offsets
              holder.getTotalOffset = function () {
                return totalOffsets[index];
              };
              return holder;
            },
          get: function () {
            return null;
          },
        };
        var opf = await adapt_epub.OPFDoc.fromChapters(store, "", [
          { url: "http://example.com/a.html", index: 0 },
          { url: "http://example.com/b.html", index: 1 },
        ]);
        // Estimate the pages from the sizes of the documents (the default is
        // to count the rendered pages)
        opf.setEPageCountMode(false);
        return opf;
      }

      it("countEPages estimates the pages of each spine item and reports the running count", async function () {
        var opf = await createOpfDoc([3600, 1800]);
        var counts = [];
        var result = await opf.countEPages(function (count) {
          counts.push(count);
        });
        expect(result).toBe(true);
        expect(counts).toEqual([2, 3]);
        expect(opf.epageCount).toBe(3);
        expect(opf.spine[0].epage).toBe(0);
        expect(opf.spine[0].epageCount).toBe(2);
        expect(opf.spine[1].epage).toBe(2);
        expect(opf.spine[1].epageCount).toBe(1);
      });

      it("countEPages stops when the signal is aborted", async function () {
        var opf = await createOpfDoc([3600, 1800]);
        var controller = new AbortController();
        var counts = [];
        await expectAsync(
          opf.countEPages(function (count) {
            counts.push(count);
            controller.abort(new Error("canceled for the test"));
          }, controller.signal),
        ).toBeRejectedWithError("canceled for the test");
        // The second spine item was not counted
        expect(counts).toEqual([2]);
      });

      it("getEPageFromPosition returns the epage proportional to the offset", async function () {
        var opf = await createOpfDoc([3600, 1800]);
        await opf.countEPages(null);
        expect(
          await opf.getEPageFromPosition({
            spineIndex: 0,
            offsetInItem: 0,
            pageIndex: -1,
          }),
        ).toBe(0);
        expect(
          await opf.getEPageFromPosition({
            spineIndex: 0,
            offsetInItem: 1800,
            pageIndex: -1,
          }),
        ).toBe(1);
        expect(
          await opf.getEPageFromPosition({
            spineIndex: 1,
            offsetInItem: 900,
            pageIndex: -1,
          }),
        ).toBe(2.5);
      });

      it("getEPageFromPosition counts rendered pages in the rendered-page mode", async function () {
        var opf = await createOpfDoc([3600, 1800]);
        opf.setEPageCountMode(true);
        opf.spine[1].epage = 5;
        expect(
          await opf.getEPageFromPosition({
            spineIndex: 1,
            offsetInItem: -1,
            pageIndex: 3,
          }),
        ).toBe(8);
      });

      it("resolveEPage finds the spine item and the offset of an epage", async function () {
        var opf = await createOpfDoc([3600, 1800]);
        await opf.countEPages(null);
        expect(await opf.resolveEPage(0)).toEqual({
          spineIndex: 0,
          offsetInItem: 0,
          pageIndex: -1,
        });
        expect(await opf.resolveEPage(1)).toEqual({
          spineIndex: 0,
          offsetInItem: 1800,
          pageIndex: -1,
        });
        expect(await opf.resolveEPage(2.5)).toEqual({
          spineIndex: 1,
          offsetInItem: 900,
          pageIndex: -1,
        });
      });

      it("resolveEPage finds the page index in the rendered-page mode", async function () {
        var opf = await createOpfDoc([3600, 1800]);
        opf.setEPageCountMode(true);
        opf.spine[0].epage = 0;
        opf.spine[0].epageCount = 4;
        opf.spine[1].epage = 4;
        opf.spine[1].epageCount = 3;
        expect(await opf.resolveEPage(5)).toEqual({
          spineIndex: 1,
          offsetInItem: -1,
          pageIndex: 1,
        });
      });

      it("resolveEPage gives null and logs when the document cannot be loaded", async function () {
        spyOn(adapt_logging.logger, "warn");
        var opf = await createOpfDoc([3600, 1800], async function () {
          throw new Error("cannot load");
        });
        opf.spine[0].epage = 0;
        opf.spine[0].epageCount = 2;
        opf.spine[1].epage = 2;
        opf.spine[1].epageCount = 1;
        expect(await opf.resolveEPage(1)).toBeNull();
        expect(adapt_logging.logger.warn).toHaveBeenCalled();
      });

      it("resolveFragment gives null for an empty or invalid fragment", async function () {
        spyOn(adapt_logging.logger, "warn");
        var opf = await createOpfDoc([3600, 1800]);
        expect(await opf.resolveFragment(null)).toBeNull();
        expect(await opf.resolveFragment("")).toBeNull();
        expect(await opf.resolveFragment("not a cfi")).toBeNull();
      });

      it("getCFI gives a path to the node at an offset", async function () {
        var opf = await createOpfDoc([3600, 1800]);
        var cfi = await opf.getCFI(0, 0);
        expect(typeof cfi).toBe("string");
        expect(cfi.length).toBeGreaterThan(0);
      });
    });

    describe("OPFDocumentURLTransformer", function () {
      var opfDoc;
      var transformer;

      beforeAll(async function () {
        opfDoc = await adapt_epub.OPFDoc.fromChapters(null, "", [
          { url: "http://example.com:8000/foo/bar1.html", index: 0 },
          { url: "http://example.com:8000/foo/bar2.html", index: 1 },
        ]);
        transformer = opfDoc.createDocumentURLTransformer();
      });

      var illegalCharRegexp = /[^-a-zA-Z0-9_:]/;

      describe("transformFragment / restoreURL", function () {
        var baseURL = "http://base.org:9000/baz.html";
        var fragment = "some-fragment";
        var transformed;

        beforeAll(function () {
          transformed = transformer.transformFragment(fragment, baseURL);
        });

        it("transforms a pair of a fragment and a base URL into an XML ID string", function () {
          expect(transformed).not.toMatch(illegalCharRegexp);
          expect(transformed.indexOf(adapt_epub.transformedIdPrefix)).toBe(0);
        });

        it("restores a pair of the original base URL and the original fragment", function () {
          var restored = transformer.restoreURL(transformed);
          expect(restored).toEqual([baseURL, fragment]);

          restored = transformer.restoreURL("#" + transformed);
          expect(restored).toEqual([baseURL, fragment]);
        });

        it("canonicalizes a redirected loaded document URL to the spine source URL", async function () {
          var store = {
            get: function (url) {
              return url === "http://example.com:8000/foo/bar1.html"
                ? { url: "http://example.com:8000/foo/bar1" }
                : null;
            },
          };
          var redirectedOpfDoc = await adapt_epub.OPFDoc.fromChapters(
            store,
            "",
            [{ url: "http://example.com:8000/foo/bar1.html", index: 0 }],
          );
          var redirectedTransformer =
            redirectedOpfDoc.createDocumentURLTransformer();

          var redirectedBaseURL = "http://example.com:8000/foo/bar1";
          var redirectedTransformed = redirectedTransformer.transformFragment(
            fragment,
            redirectedBaseURL,
          );

          expect(
            redirectedTransformer.restoreURL(redirectedTransformed),
          ).toEqual(["http://example.com:8000/foo/bar1.html", fragment]);
        });
      });

      describe("transformURL", function () {
        var fragment = "some-fragment";

        it("transforms a URL internal to the document into an XML ID string", function () {
          var baseURL = opfDoc.items[1].src;

          var transformed = transformer.transformURL("#" + fragment, baseURL);
          expect(transformed.charAt(0)).toBe("#");
          expect(transformed.substring(1)).not.toMatch(illegalCharRegexp);

          transformed = transformer.transformURL(baseURL + "#" + fragment);
          expect(transformed.charAt(0)).toBe("#");
          expect(transformed.substring(1)).not.toMatch(illegalCharRegexp);

          var restored = transformer.restoreURL(transformed);
          expect(restored).toEqual([baseURL, fragment]);
        });

        it("does not transform an external URL", function () {
          var baseURL = "http://base.org:9000/baz.html";

          var transformed = transformer.transformURL("#" + fragment, baseURL);
          expect(transformed).toBe("#" + fragment);

          transformed = transformer.transformURL(baseURL + "#" + fragment);
          expect(transformed).toBe(baseURL + "#" + fragment);
        });

        it("transforms a redirected same-document URL using the canonical spine URL", async function () {
          var store = {
            get: function (url) {
              return url === "http://example.com:8000/foo/bar1.html"
                ? { url: "http://example.com:8000/foo/bar1" }
                : null;
            },
          };
          var redirectedOpfDoc = await adapt_epub.OPFDoc.fromChapters(
            store,
            "",
            [{ url: "http://example.com:8000/foo/bar1.html", index: 0 }],
          );
          var redirectedTransformer =
            redirectedOpfDoc.createDocumentURLTransformer();
          var redirectedBaseURL = "http://example.com:8000/foo/bar1";

          var transformed = redirectedTransformer.transformURL(
            "#" + fragment,
            redirectedBaseURL,
          );
          expect(transformed.charAt(0)).toBe("#");

          expect(redirectedTransformer.restoreURL(transformed)).toEqual([
            "http://example.com:8000/foo/bar1.html",
            fragment,
          ]);
        });
      });
    });
  });

  describe("readMetadata", function () {
    var url = "foobar";

    it("parses DC11 terms in order", function () {
      var doc = new DOMParser().parseFromString(
        `
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="pub-id">urn:uuid:A1B0D67E-2E81-4DF5-9E67-A64CBE366809</dc:identifier>
        <dc:title>Norwegian Wood</dc:title>
        <dc:language>en</dc:language>
      </metadata>`,
        "text/xml",
      );
      var holder = new adapt_xmldoc.XMLDocHolder(null, url, doc);
      var items = holder.doc().childElements();
      var metadata = adapt_epub.readMetadata(items);

      expect(metadata["http://purl.org/dc/terms/identifier"]).toEqual([
        { v: "urn:uuid:A1B0D67E-2E81-4DF5-9E67-A64CBE366809", o: 1 },
      ]);

      expect(metadata["http://purl.org/dc/terms/title"]).toEqual([
        { v: "Norwegian Wood", o: 2 },
      ]);

      expect(metadata["http://purl.org/dc/terms/language"]).toEqual([
        { v: "en", o: 3 },
      ]);
    });

    it("parses DCTERMS properties in order", function () {
      var doc = new DOMParser().parseFromString(
        `
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <meta property="dcterms:modified">2011-01-01T12:00:00Z</meta>
      </metadata>`,
        "text/xml",
      );
      var holder = new adapt_xmldoc.XMLDocHolder(null, url, doc);
      var items = holder.doc().childElements();
      var metadata = adapt_epub.readMetadata(items);

      expect(metadata["http://purl.org/dc/terms/modified"]).toEqual([
        { v: "2011-01-01T12:00:00Z", o: 1 },
      ]);
    });

    it("parses refinement properties", function () {
      var doc = new DOMParser().parseFromString(
        `
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:creator id="creator">Haruki Murakami</dc:creator>
        <meta refines="#creator" property="role" scheme="marc:relators" id="role">aut</meta>
        <meta refines="#creator" property="alternate-script" xml:lang="ja">村上 春樹</meta>
        <meta refines="#creator" property="file-as">Murakami, Haruki</meta>
      </metadata>`,
        "text/xml",
      );
      var holder = new adapt_xmldoc.XMLDocHolder(null, url, doc);
      var items = holder.doc().childElements();
      var metadata = adapt_epub.readMetadata(items);

      expect(metadata["http://purl.org/dc/terms/creator"]).toEqual([
        {
          v: "Haruki Murakami",
          o: 1,
          r: {
            "http://idpf.org/epub/vocab/package/meta/#role": [
              { v: "aut", o: 2, s: "http://id.loc.gov/vocabulary/relators" },
            ],
            "http://idpf.org/epub/vocab/package/meta/#alternate-script": [
              { v: "村上 春樹", o: 3 },
            ],
            "http://idpf.org/epub/vocab/package/meta/#file-as": [
              { v: "Murakami, Haruki", o: 4 },
            ],
          },
        },
      ]);
    });

    it("parses role properties", function () {
      var doc = new DOMParser().parseFromString(
        `
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:creator opf:role="aut">Harkaitz Cano</dc:creator>
        <dc:creator opf:role="trl">Roberta Gozzi</dc:creator>
        <dc:contributor opf:role="bkp">calibre (3.12.0) [https://calibre-ebook.com]</dc:contributor>
      </metadata>`,
        "text/xml",
      );
      var holder = new adapt_xmldoc.XMLDocHolder(null, url, doc);
      var items = holder.doc().childElements();
      var metadata = adapt_epub.readMetadata(items);

      expect(metadata["http://purl.org/dc/terms/creator"]).toEqual([
        {
          v: "Harkaitz Cano",
          o: 1,
          r: {
            "http://idpf.org/epub/vocab/package/meta/#role": [
              { v: "aut", o: 1 },
            ],
          },
        },
        {
          v: "Roberta Gozzi",
          o: 2,
          r: {
            "http://idpf.org/epub/vocab/package/meta/#role": [
              { v: "trl", o: 2 },
            ],
          },
        },
      ]);

      expect(metadata["http://purl.org/dc/terms/contributor"]).toEqual([
        {
          v: "calibre (3.12.0) [https://calibre-ebook.com]",
          o: 3,
          r: {
            "http://idpf.org/epub/vocab/package/meta/#role": [
              { v: "bkp", o: 3 },
            ],
          },
        },
      ]);
    });
  });
  describe("OPFView page view items", function () {
    function createView(spineLength) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.opf = {
        spine: Array.from({ length: spineLength }, function (_, i) {
          return { src: "doc-" + i, spineIndex: i };
        }),
      };
      view.spineItems = [];
      view.spineItemLoading = [];
      return view;
    }

    // Loads a fake view item after a delay, as loadPageViewItem does
    function fakeLoader(view, loaded) {
      return spyOn(view, "loadPageViewItem").and.callFake(async function (i) {
        loaded.push(i);
        await new Promise(function (resolve) {
          setTimeout(resolve, 5);
        });
        var viewItem = { item: view.opf.spine[i], pages: [] };
        view.spineItems[i] = viewItem;
        return viewItem;
      });
    }

    it("gives null for a spine index that does not exist", async function () {
      var view = createView(2);
      var loaded = [];
      fakeLoader(view, loaded);
      expect(await view.getPageViewItem(-1)).toBeNull();
      expect(await view.getPageViewItem(2)).toBeNull();
      expect(loaded).toEqual([]);
    });

    it("loads a spine item once for concurrent requests and gives them the same view item", async function () {
      var view = createView(2);
      var loaded = [];
      fakeLoader(view, loaded);
      var results = await Promise.all([
        view.getPageViewItem(1),
        view.getPageViewItem(1),
        view.getPageViewItem(1),
      ]);
      expect(loaded).toEqual([1]);
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
      expect(view.spineItems[1]).toBe(results[0]);
    });

    it("does not load a spine item that is already loaded", async function () {
      var view = createView(2);
      var loaded = [];
      fakeLoader(view, loaded);
      var viewItem = { pages: [] };
      view.spineItems[0] = viewItem;
      expect(await view.getPageViewItem(0)).toBe(viewItem);
      expect(loaded).toEqual([]);
    });

    it("loads the spine item again after it was discarded", async function () {
      var view = createView(2);
      var loaded = [];
      fakeLoader(view, loaded);
      var first = await view.getPageViewItem(0);
      // What the invalidation of the following spine items does
      view.spineItems[0] = null;
      view.spineItemLoading[0] = null;
      var second = await view.getPageViewItem(0);
      expect(loaded).toEqual([0, 0]);
      expect(second).not.toBe(first);
    });

    it("rejects every request that waits for a loading that fails", async function () {
      var view = createView(2);
      spyOn(view, "loadPageViewItem").and.callFake(async function () {
        await new Promise(function (resolve) {
          setTimeout(resolve, 5);
        });
        throw new Error("cannot load the spine item");
      });
      var first = view.getPageViewItem(0);
      var second = view.getPageViewItem(0);
      await expectAsync(first).toBeRejectedWithError(
        "cannot load the spine item",
      );
      await expectAsync(second).toBeRejectedWithError(
        "cannot load the spine item",
      );
    });
  });

  describe("OPFView page rendering", function () {
    it("wakes up a waiting navigation when the lock is released", async function () {
      var lock = new adapt_epub.RenderLock();
      var holder = {};
      lock.tryAcquire(holder);
      var start = performance.now();
      setTimeout(function () {
        lock.release(holder);
      }, 20);
      await lock.changed(2000);
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it("hands the lock to all the waiters of the same owner at once", async function () {
      var lock = new adapt_epub.RenderLock();
      var holder = {};
      var first = {};
      var second = {};
      lock.tryAcquire(holder);
      var granted = [];
      // `second` waits twice, and `first` waits between them
      var waiters = [
        lock.acquire(second).then(() => granted.push("second-1")),
        lock.acquire(first).then(() => granted.push("first")),
        lock.acquire(second).then(() => granted.push("second-2")),
      ];
      lock.release(holder);
      // Both waiters of `second` (not only the first one) have the lock
      await Promise.all([waiters[0], waiters[2]]);
      expect(granted).toEqual(["second-1", "second-2"]);
      expect(lock.isHeldByAnother(first)).toBe(true);
      // `first` gets the lock after `second` has released it as many times as it took it
      lock.release(second);
      lock.release(second);
      await waiters[1];
      expect(granted).toEqual(["second-1", "second-2", "first"]);
      expect(lock.isHeldByAnother(second)).toBe(true);
      lock.release(first);
      expect(lock.isHeldByAnother({})).toBe(false);
    });

    it("keeps the lock for the owner until all the grants are released", async function () {
      var lock = new adapt_epub.RenderLock();
      var holder = {};
      var other = {};
      var third = {};
      lock.tryAcquire(holder);
      var waiters = [lock.acquire(other), lock.acquire(other)];
      var thirdWaiter = lock.acquire(third);
      lock.release(holder);
      await Promise.all(waiters);
      // two grants: the lock is not free after one release
      lock.release(other);
      expect(lock.isHeldByAnother(third)).toBe(true);
      lock.release(other);
      await thirdWaiter;
      expect(lock.isHeldByAnother(other)).toBe(true);
      lock.release(third);
    });

    it("stops waiting for a change when the signal is aborted", async function () {
      var lock = new adapt_epub.RenderLock();
      var abort = new AbortController();
      var reason = new Error("canceled");
      var pending = lock.changed(2000, abort.signal);
      abort.abort(reason);
      await expectAsync(pending).toBeRejectedWith(reason);
    });

    it("releases the render lock after an error", async function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var error = new Error("render failed");
      spyOn(view, "renderPageTracked").and.throwError(error);
      var owner = {};

      await expectAsync(
        view.renderPage(
          { spineIndex: 0, pageIndex: 0, offsetInItem: -1 },
          { owner: owner },
        ),
      ).toBeRejectedWith(error);
      expect(view.renderLock.isHeldByAnother({})).toBe(false);
      expect(view.renderLock.tryAcquire({})).toBe(true);
    });

    it("lets only one owner render a page at a time", async function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var log = [];
      spyOn(view, "renderPageTracked").and.callFake(async function (position) {
        log.push("start " + position.spineIndex);
        await new Promise(function (resolve) {
          setTimeout(resolve, 10);
        });
        log.push("end " + position.spineIndex);
        return { id: position.spineIndex };
      });
      view.pageSheetSizeTruncator = function () {};
      view.getRenderedPageSizeCount = function () {
        return 0;
      };
      var first = view.renderPage(
        { spineIndex: 0, pageIndex: 0, offsetInItem: -1 },
        { owner: {} },
      );
      var second = view.renderPage(
        { spineIndex: 1, pageIndex: 0, offsetInItem: -1 },
        { owner: {} },
      );
      expect(await first).toEqual({ id: 0 });
      expect(await second).toEqual({ id: 1 });
      expect(log).toEqual(["start 0", "end 0", "start 1", "end 1"]);
    });

    it("stops waiting for the render lock when the rendering is canceled", async function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var holder = {};
      view.renderLock.tryAcquire(holder);
      var abort = new AbortController();
      var pending = view.renderPage(
        { spineIndex: 0, pageIndex: 0, offsetInItem: -1 },
        { owner: {}, signal: abort.signal },
      );
      var reason = new Error("canceled");
      abort.abort(reason);
      await expectAsync(pending).toBeRejectedWith(reason);
      view.renderLock.release(holder);
      expect(view.renderLock.tryAcquire({})).toBe(true);
    });

    it("waits for a pending page being rendered by another task", async function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var page = {};
      var viewItem = {
        complete: false,
        layoutPositions: [{ page: 0 }, { page: 1 }],
        pages: [{}],
      };
      spyOn(view, "getPageViewItem").and.returnValue(Promise.resolve(viewItem));
      spyOn(view, "renderPage").and.callThrough();
      var background = {};
      view.renderLock.tryAcquire(background);
      setTimeout(function () {
        viewItem.pages[1] = page;
        view.renderLock.release(background);
      }, 50);

      var result = await view.findPage(
        { spineIndex: 0, pageIndex: 1, offsetInItem: -1 },
        false,
      );
      expect(result.page).toBe(page);
      expect(view.renderPage).not.toHaveBeenCalled();
    });

    it("processes a pending suffix rebuild before returning a cached page", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var position = { spineIndex: 1, pageIndex: 0, offsetInItem: -1 };
      var cachedPage = {};
      var rebuiltPage = {};
      view.deferredFollowingSpineRelayoutStart = 1;
      view.renderLock = new adapt_epub.RenderLock();
      spyOn(view, "waitForPreviousSpines").and.returnValue(
        Promise.resolve(true),
      );
      spyOn(view, "getPageViewItem").and.returnValue(
        Promise.resolve({ pages: [cachedPage], complete: true }),
      );
      spyOn(view, "renderPage").and.returnValue(
        Promise.resolve({
          page: rebuiltPage,
          position: position,
        }),
      );

      view.findPage(position, false).then(function (result) {
        expect(view.renderPage).toHaveBeenCalledOnceWith(
          position,
          jasmine.objectContaining({ owner: jasmine.anything() }),
        );
        expect(result.page).toBe(rebuiltPage);
        done();
      });
    });

    it("waits for background pagination to rebuild a cached suffix page", async function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      spyOn(view, "waitForPreviousSpines").and.returnValue(
        Promise.resolve(true),
      );
      var position = { spineIndex: 1, pageIndex: 0, offsetInItem: -1 };
      var stalePage = {};
      var rebuiltPage = {};
      var viewItem = { pages: [stalePage], complete: true };
      view.deferredFollowingSpineRelayoutStart = 1;
      view.renderingAllPages = true;
      spyOn(view, "getPageViewItem").and.callFake(function () {
        return Promise.resolve(viewItem);
      });
      spyOn(view, "renderPage").and.returnValue(
        Promise.resolve({ page: stalePage, position: position }),
      );
      // The rebuild finishes without anyone announcing it: the waiting
      // navigation notices by itself.
      setTimeout(function () {
        viewItem.pages[0] = rebuiltPage;
        view.deferredFollowingSpineRelayoutStart = null;
        view.renderingAllPages = false;
      }, 50);

      var result = await view.findPage(position, false);
      expect(result.page).toBe(rebuiltPage);
      expect(view.renderPage).not.toHaveBeenCalled();
    });

    it("does not return an invalid cached suffix page synchronously", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var position = { spineIndex: 1, pageIndex: 0, offsetInItem: -1 };
      view.deferredFollowingSpineRelayoutStart = 1;
      view.renderingAllPages = true;
      spyOn(view, "waitForPreviousSpines").and.returnValue(
        Promise.resolve(true),
      );
      spyOn(view, "renderPage");

      view.findPage(position, true).then(function (result) {
        expect(result).toBeNull();
        expect(view.renderPage).not.toHaveBeenCalled();
        done();
      });
    });

    it("waits for another navigation task to rebuild an invalid suffix", async function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var position = { spineIndex: 1, pageIndex: 0, offsetInItem: -1 };
      var rebuiltPage = {};
      var viewItem = { pages: [rebuiltPage], complete: true };
      view.deferredFollowingSpineRelayoutStart = 1;
      view.renderingAllPages = false;
      view.renderLock = new adapt_epub.RenderLock();
      spyOn(view, "waitForPreviousSpines").and.returnValue(
        Promise.resolve(true),
      );
      var otherOwner = {};
      view.renderLock.tryAcquire(otherOwner);
      spyOn(view, "getPageViewItem").and.returnValue(Promise.resolve(viewItem));
      spyOn(view, "renderPage");
      setTimeout(function () {
        view.deferredFollowingSpineRelayoutStart = null;
        view.renderLock.release(otherOwner);
      }, 50);

      var result = await view.findPage(position, false);
      expect(result.page).toBe(rebuiltPage);
      expect(view.renderPage).not.toHaveBeenCalled();
    });

    it("does not start a synchronous invalid-suffix rebuild in parallel", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var position = { spineIndex: 1, pageIndex: 0, offsetInItem: -1 };
      view.deferredFollowingSpineRelayoutStart = 1;
      view.renderingAllPages = false;
      view.renderLock = new adapt_epub.RenderLock();
      view.renderLock.tryAcquire({});
      spyOn(view, "waitForPreviousSpines").and.returnValue(
        Promise.resolve(true),
      );
      spyOn(view, "renderPage");

      view.findPage(position, true).then(function (result) {
        expect(result).toBeNull();
        expect(view.renderPage).not.toHaveBeenCalled();
        done();
      });
    });

    it("waits until an in-progress suffix rebuild has completed", async function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      spyOn(view, "waitForPreviousSpines").and.returnValue(
        Promise.resolve(true),
      );
      var position = { spineIndex: 1, pageIndex: 0, offsetInItem: -1 };
      var rebuiltPage = {};
      view.relayoutingFollowingSpineStart = 1;
      spyOn(view, "getPageViewItem").and.returnValue(
        Promise.resolve({ pages: [rebuiltPage], complete: true }),
      );
      setTimeout(function () {
        view.relayoutingFollowingSpineStart = null;
        view.notifyRenderChange();
      }, 50);

      var result = await view.findPage(position, false);
      expect(result.page).toBe(rebuiltPage);
    });

    it("does not expose an in-progress suffix rebuild synchronously", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var position = { spineIndex: 1, pageIndex: 0, offsetInItem: -1 };
      view.relayoutingFollowingSpineStart = 1;
      spyOn(view, "waitForPreviousSpines").and.returnValue(
        Promise.resolve(true),
      );
      spyOn(view, "getPageViewItem");

      view.findPage(position, true).then(function (result) {
        expect(result).toBeNull();
        expect(view.getPageViewItem).not.toHaveBeenCalled();
        done();
      });
    });

    it("reuses the requested slot when a final-page rerender shrinks the spine", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var page = {
        spineIndex: 0,
        offset: 15,
        fetchers: [],
        embeddedContentFetchers: [],
      };
      var stalePageReplaced = jasmine.createSpy("stalePageReplaced");
      var currentItem = {
        spineIndex: 0,
        epage: 0,
        epageCount: 17,
      };
      var followingItem = {
        spineIndex: 1,
        epage: 17,
        epageCount: 3,
      };
      var epageCountCallback = jasmine.createSpy("epageCountCallback");
      var viewItem = {
        item: currentItem,
        layoutPositions: new Array(17).fill(null),
        pages: Array.from({ length: 17 }, function (_, pageIndex) {
          return {
            offset: pageIndex,
            container: { remove: function () {} },
            dispatchEvent:
              pageIndex === 16 ? stalePageReplaced : function () {},
          };
        }),
        pageCounterStarts: new Array(17).fill(null),
        instance: {
          pageNumberOffset: 0,
          viewport: {
            layoutBox: { removeAttribute: function () {} },
          },
          getPageNumberContextDepth: function () {
            return 0;
          },
          pushPageNumberContext: function () {},
          restorePageNumberContextDepth: function () {},
          layoutNextPage: function () {
            return Promise.resolve(null);
          },
        },
      };
      view.opf = {
        epageIsRenderedPage: true,
        spine: [currentItem, followingItem],
        epageCount: 20,
        epageCountCallback: epageCountCallback,
      };
      view.spineItems = [viewItem];
      view.spineItemLoading = [null];
      view.deferredPageReplacements = new Map();
      view.pageSheetSizeTruncator = jasmine.createSpy("pageSheetSizeTruncator");
      view.deferredReferencePages = [
        { viewItem: viewItem, pageIndex: 15 },
        { viewItem: viewItem, pageIndex: 16 },
      ];
      view.counterStore = {
        finishPage: function () {},
        discardReferencesFromPage: jasmine.createSpy(),
      };
      view.isInCounterResolveScope = function () {
        return false;
      };
      view.preparePageCountersForRender = function () {
        return null;
      };
      view.makePage = function () {
        return page;
      };
      view.resolvePageTypeForRenderSlot = function () {};
      spyOn(view, "finishPageContainer").and.callFake(
        function (item, renderedPage, pageIndex) {
          item.pages[pageIndex] = renderedPage;
        },
      );
      view.reportPaginationProgress = function () {};
      view.maybeRelayoutFollowingPage = function () {
        expect(viewItem.complete).not.toBe(true);
        return Promise.resolve();
      };
      view.resolveUnresolvedReferencesForPage = function () {
        expect(viewItem.complete).not.toBe(true);
        return Promise.resolve(page);
      };

      view.renderSinglePage(viewItem, { page: 15 }).then(function () {
        expect(view.finishPageContainer).toHaveBeenCalledWith(
          viewItem,
          page,
          15,
        );
        expect(viewItem.pages.length).toBe(16);
        expect(viewItem.layoutPositions.length).toBe(16);
        expect(viewItem.pageCounterStarts.length).toBe(16);
        expect(
          view.counterStore.discardReferencesFromPage,
        ).toHaveBeenCalledOnceWith(0, 16);
        expect(view.deferredReferencePages).toEqual([
          { viewItem: viewItem, pageIndex: 15 },
        ]);
        expect(currentItem.epageCount).toBe(16);
        expect(followingItem.epage).toBe(16);
        expect(view.opf.epageCount).toBe(19);
        expect(epageCountCallback).toHaveBeenCalledOnceWith(19);
        expect(view.pageSheetSizeTruncator).not.toHaveBeenCalled();
        expect(stalePageReplaced).toHaveBeenCalled();
        expect(stalePageReplaced.calls.mostRecent().args[0].newPage).toBe(page);
        expect(viewItem.complete).toBe(true);
        done();
      });
    });

    it("recomputes following epage ranges when a spine grows", function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var precedingItem = { spineIndex: 0, epage: 0, epageCount: 10 };
      var grownItem = { spineIndex: 1, epage: 10, epageCount: 5 };
      var loadedFollowingItem = { spineIndex: 2, epage: 15, epageCount: 3 };
      var unloadedFollowingItem = { spineIndex: 3, epage: 18, epageCount: 4 };
      var epageCountCallback = jasmine.createSpy("epageCountCallback");
      view.opf = {
        epageIsRenderedPage: true,
        spine: [
          precedingItem,
          grownItem,
          loadedFollowingItem,
          unloadedFollowingItem,
        ],
        epageCount: 22,
        epageCountCallback: epageCountCallback,
      };
      // Only the loaded following spine has a view item; the last one is
      // not yet rendered and must still get its epage start recomputed.
      view.spineItems = [
        null,
        { item: grownItem },
        { item: loadedFollowingItem },
        null,
      ];

      view.updateEPageRangesAfterPageCountChange({ item: grownItem }, 7);

      expect(grownItem.epageCount).toBe(7);
      expect(loadedFollowingItem.epage).toBe(17);
      expect(unloadedFollowingItem.epage).toBe(20);
      expect(view.opf.epageCount).toBe(24);
      expect(epageCountCallback).toHaveBeenCalledOnceWith(24);
    });

    it("keeps epage ranges when epage is not the rendered page", function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var changedItem = { spineIndex: 0, epage: 0, epageCount: 10 };
      var followingItem = { spineIndex: 1, epage: 10, epageCount: 3 };
      var epageCountCallback = jasmine.createSpy("epageCountCallback");
      view.opf = {
        epageIsRenderedPage: false,
        spine: [changedItem, followingItem],
        epageCount: 13,
        epageCountCallback: epageCountCallback,
      };

      view.updateEPageRangesAfterPageCountChange({ item: changedItem }, 12);

      expect(changedItem.epageCount).toBe(10);
      expect(followingItem.epage).toBe(10);
      expect(view.opf.epageCount).toBe(13);
      expect(epageCountCallback).not.toHaveBeenCalled();
    });

    it("defers final-page completion while a counter scope is still pushed", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var page = {
        spineIndex: 0,
        offset: 0,
        fetchers: [],
        embeddedContentFetchers: [],
      };
      var removeLayoutStyle = jasmine.createSpy("removeLayoutStyle");
      var restorePageNumberContext = jasmine.createSpy(
        "restorePageNumberContext",
      );
      var viewItem = {
        item: { spineIndex: 0 },
        layoutPositions: [null],
        pages: [],
        pageCounterStarts: [null],
        instance: {
          pageNumberOffset: 0,
          viewport: {
            layoutBox: { removeAttribute: removeLayoutStyle },
          },
          getPageNumberContextDepth: function () {
            return 0;
          },
          pushPageNumberContext: function () {},
          restorePageNumberContextDepth: restorePageNumberContext,
          layoutNextPage: function () {
            return Promise.resolve(null);
          },
        },
      };
      view.counterStore = {
        finishPage: function () {},
      };
      view.deferredReferencePages = [];
      view.isInCounterResolveScope = function () {
        return true;
      };
      view.preparePageCountersForRender = function () {
        return null;
      };
      view.makePage = function () {
        return page;
      };
      view.resolvePageTypeForRenderSlot = function () {};
      view.finishPageContainer = function (item, renderedPage, pageIndex) {
        item.pages[pageIndex] = renderedPage;
      };
      view.collectTotalOffsets = function () {
        return Promise.resolve(true);
      };
      view.reportPaginationProgress = function () {};
      view.maybeRelayoutFollowingPage = function () {
        return Promise.resolve();
      };
      view.resolveUnresolvedReferencesForPage = function () {
        return Promise.resolve(page);
      };

      view.renderSinglePage(viewItem, { page: 0 }).then(function () {
        expect(viewItem.pages).toEqual([page]);
        expect(viewItem.complete).not.toBe(true);
        expect(removeLayoutStyle).not.toHaveBeenCalled();
        expect(restorePageNumberContext).toHaveBeenCalledOnceWith(0);
        done();
      });
    });

    it("discards following spines after an earlier spine shrinks", function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var sourcePage = { container: { remove: jasmine.createSpy() } };
      var followingPage1 = { container: { remove: jasmine.createSpy() } };
      var followingPage2 = { container: { remove: jasmine.createSpy() } };
      var sourceItem = { item: { spineIndex: 0 }, pages: [sourcePage] };
      var followingItem1 = {
        item: { spineIndex: 1 },
        pages: [followingPage1],
      };
      var followingItem2 = {
        item: { spineIndex: 2 },
        pages: [followingPage2],
      };
      view.spineItems = [sourceItem, followingItem1, followingItem2];
      view.spineItemLoading = [
        Promise.resolve(),
        Promise.resolve(),
        Promise.resolve(),
      ];
      view.deferredPageReplacements = new Map();
      var deferredReferencePages = [
        { viewItem: sourceItem },
        { viewItem: followingItem1 },
      ];
      view.deferredReferencePages = deferredReferencePages;
      view.counterStore = {
        discardReferencesFromSpine: jasmine.createSpy(),
      };

      view.deferFollowingSpinesForRelayout(0);
      view.relayoutDeferredFollowingSpines();

      expect(view.spineItems[0]).toBe(sourceItem);
      expect(view.spineItems[1]).toBeNull();
      expect(view.spineItems[2]).toBeNull();
      expect(sourcePage.container.remove).not.toHaveBeenCalled();
      expect(followingPage1.container.remove).toHaveBeenCalled();
      expect(followingPage2.container.remove).toHaveBeenCalled();
      expect(view.spineItemLoading[1]).toBeNull();
      expect(view.spineItemLoading[2]).toBeNull();
      expect(view.deferredReferencePages).toBe(deferredReferencePages);
      expect(view.deferredReferencePages).toEqual([{ viewItem: sourceItem }]);
      expect(view.counterStore.discardReferencesFromSpine).toHaveBeenCalledWith(
        1,
      );
    });

    it("notifies a displayed page when its rebuilt replacement is ready", function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var contentContainer = document.createElement("div");
      var oldBlankContainer = document.createElement("div");
      var oldContentContainer = document.createElement("div");
      contentContainer.appendChild(oldBlankContainer);
      contentContainer.appendChild(oldContentContainer);
      var oldBlankPage = new adapt_vtree.Page(
        oldBlankContainer,
        oldBlankContainer,
      );
      oldBlankPage.spineIndex = 1;
      oldBlankPage.offset = 10;
      oldBlankPage.isBlankPage = true;
      var oldContentPage = new adapt_vtree.Page(
        oldContentContainer,
        oldContentContainer,
      );
      oldContentPage.spineIndex = 1;
      oldContentPage.offset = 10;
      var sourceItem = { item: { spineIndex: 0 }, pages: [] };
      var oldViewItem = {
        item: { spineIndex: 1 },
        pages: [oldBlankPage, oldContentPage],
      };
      view.opf = { epageIsRenderedPage: false };
      view.pageSheetSizeReporter = function () {};
      view.spineItems = [sourceItem, oldViewItem];
      view.spineItemLoading = [Promise.resolve(), Promise.resolve()];
      view.deferredPageReplacements = new Map();
      view.deferredReferencePages = [];
      view.counterStore = {
        discardReferencesFromSpine: function () {},
      };
      var replacedListener = jasmine.createSpy("replacedListener");
      var blankReplacedListener = jasmine.createSpy("blankReplacedListener");
      oldContentPage.addEventListener("replaced", replacedListener, false);
      oldBlankPage.addEventListener("replaced", blankReplacedListener, false);

      view.deferFollowingSpinesForRelayout(0);
      view.relayoutDeferredFollowingSpines();

      var newContainer = document.createElement("div");
      var newPage = new adapt_vtree.Page(newContainer, newContainer);
      newPage.side = "right";
      newPage.offset = 10;
      var newViewItem = {
        item: { spineIndex: 1 },
        pages: [],
        layoutPositions: [null],
        instance: {
          viewport: {
            contentContainer: contentContainer,
            layoutBox: { removeAttribute: function () {} },
          },
          pageSheetWidth: 0,
          pageSheetHeight: 0,
          pageSheetSize: {},
          pageNumberOffset: 0,
        },
      };
      view.spineItems[1] = newViewItem;
      view.finishPageContainer(newViewItem, newPage, 0);

      expect(replacedListener).toHaveBeenCalled();
      expect(replacedListener.calls.mostRecent().args[0].newPage).toBe(newPage);
      expect(newContainer.parentElement).toBe(contentContainer);
      var laterBlankContainer = document.createElement("div");
      var laterBlankPage = new adapt_vtree.Page(
        laterBlankContainer,
        laterBlankContainer,
      );
      laterBlankPage.offset = 100;
      laterBlankPage.isBlankPage = true;
      newViewItem.pages.push(laterBlankPage);
      newViewItem.layoutPositions.push(null);
      view.markSpineItemCompleteIfReady(newViewItem);
      expect(blankReplacedListener).toHaveBeenCalled();
      expect(blankReplacedListener.calls.mostRecent().args[0].newPage).toBe(
        newPage,
      );
      expect(view.deferredPageReplacements.size).toBe(0);
    });

    it("notifies both intermediate and original pages after recursive replacement", function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var contentContainer = document.createElement("div");
      var originalContainer = document.createElement("div");
      var intermediateContainer = document.createElement("div");
      contentContainer.appendChild(intermediateContainer);
      var originalPage = new adapt_vtree.Page(
        originalContainer,
        originalContainer,
      );
      originalPage.offset = 10;
      var intermediatePage = new adapt_vtree.Page(
        intermediateContainer,
        intermediateContainer,
      );
      intermediatePage.offset = 20;
      var newContainer = document.createElement("div");
      var newPage = new adapt_vtree.Page(newContainer, newContainer);
      newPage.offset = 10;
      newPage.side = "right";
      var viewItem = {
        item: { spineIndex: 1 },
        pages: [intermediatePage],
        instance: {
          viewport: { contentContainer: contentContainer },
          pageSheetWidth: 0,
          pageSheetHeight: 0,
          pageSheetSize: {},
          pageNumberOffset: 0,
        },
      };
      view.opf = { epageIsRenderedPage: false };
      view.spineItems = [null, viewItem];
      view.pageSheetSizeReporter = function () {};
      view.deferredPageReplacements = new Map([[1, [originalPage]]]);
      var originalListener = jasmine.createSpy("originalListener");
      var intermediateListener = jasmine.createSpy("intermediateListener");
      originalPage.addEventListener("replaced", originalListener, false);
      intermediatePage.addEventListener(
        "replaced",
        intermediateListener,
        false,
      );

      view.finishPageContainer(viewItem, newPage, 0);

      expect(originalListener).toHaveBeenCalled();
      expect(intermediateListener).toHaveBeenCalled();
      expect(originalListener.calls.mostRecent().args[0].newPage).toBe(newPage);
      expect(intermediateListener.calls.mostRecent().args[0].newPage).toBe(
        newPage,
      );
      expect(view.deferredPageReplacements.size).toBe(0);
    });

    it("keeps the earliest following spine queued for relayout", function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.spineItems = [];
      view.spineItemLoading = [];

      view.deferFollowingSpinesForRelayout(3);
      view.deferFollowingSpinesForRelayout(1);

      expect(view.deferredFollowingSpineRelayoutStart).toBe(2);
    });

    it("refreshes target references in rebuilt suffix pages", function () {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var prefixPage = { id: "prefix" };
      var rebuiltPage = { id: "rebuilt" };
      view.spineItems = [
        { item: { spineIndex: 0 }, pages: [prefixPage] },
        { item: { spineIndex: 1 }, pages: [rebuiltPage] },
      ];
      view.counterStore = {
        updateTargetCounterNodesInPages: jasmine
          .createSpy()
          .and.callFake(function (pages, changedTargetIds) {
            changedTargetIds.add("counter-target");
            return new Set([prefixPage]);
          }),
        updateTargetTextNodesInPages: jasmine
          .createSpy()
          .and.callFake(function (pages, changedTargetIds) {
            changedTargetIds.add("text-target");
            return new Set([rebuiltPage]);
          }),
        unresolveReferencesForTargets: jasmine.createSpy(),
      };

      var changedTargetIds = view.updateRetainedTargetCounters();

      expect(
        view.counterStore.updateTargetCounterNodesInPages,
      ).toHaveBeenCalledWith([prefixPage, rebuiltPage], jasmine.any(Set));
      expect(
        view.counterStore.updateTargetTextNodesInPages,
      ).toHaveBeenCalledWith([prefixPage, rebuiltPage], jasmine.any(Set));
      expect(changedTargetIds).toEqual(
        new Set(["counter-target", "text-target"]),
      );
      expect(
        view.counterStore.unresolveReferencesForTargets,
      ).toHaveBeenCalledOnceWith(changedTargetIds);
    });

    it("routes changed retained references through the target page resolver", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var targetPage = { id: "target-page" };
      var nextPosition = { page: 1 };
      var targetViewItem = {
        item: { spineIndex: 1 },
        pages: [targetPage],
        layoutPositions: [{ page: 0 }, nextPosition],
      };
      view.spineItems = [null, targetViewItem];
      view.counterStore = {
        pageIndicesById: {
          target1: { spineIndex: 1, pageIndex: 0 },
          target2: { spineIndex: 1, pageIndex: 0 },
        },
      };
      spyOn(view, "deferReferencesForPage");
      spyOn(view, "resolveDeferredReferencesAfterCounterScope").and.returnValue(
        Promise.resolve(targetPage),
      );

      view
        .resolveChangedRetainedTargetReferences(new Set(["target1", "target2"]))
        .then(function () {
          expect(view.deferReferencesForPage).toHaveBeenCalledOnceWith(
            targetViewItem,
            targetPage,
            0,
            nextPosition,
          );
          expect(
            view.resolveDeferredReferencesAfterCounterScope,
          ).toHaveBeenCalledOnceWith(
            targetViewItem,
            targetPage,
            0,
            nextPosition,
            undefined,
          );
          done();
        });
    });

    it("rerenders changed retained references before rebuilding the suffix", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var position = {
        spineIndex: 2,
        pageIndex: Number.POSITIVE_INFINITY,
        offsetInItem: -1,
      };
      var passStarts = [];
      view.opf = { spine: [{}, {}, {}] };
      view.spineItems = [];
      view.deferredFollowingSpineRelayoutStart = 1;
      view.relayoutingFollowingSpines = false;
      view.relayoutingFollowingSpineStart = null;
      spyOn(view, "relayoutDeferredFollowingSpines").and.callFake(function () {
        passStarts.push(view.deferredFollowingSpineRelayoutStart);
        view.deferredFollowingSpineRelayoutStart = null;
        return 2;
      });
      var context = { owner: {} };
      spyOn(view, "renderPagesUpto").and.returnValues(
        Promise.resolve({ id: "first" }),
        Promise.resolve({ id: "stable" }),
      );
      var changedTargetIds = new Set(["target"]);
      spyOn(view, "updateRetainedTargetCounters").and.returnValues(
        changedTargetIds,
        new Set(),
      );
      spyOn(view, "resolveChangedRetainedTargetReferences").and.callFake(
        function (targetIds) {
          if (targetIds.size) {
            view.deferredFollowingSpineRelayoutStart = 1;
          }
          return Promise.resolve();
        },
      );

      view
        .rerenderDeferredFollowingSpines(position, context)
        .then(function (result) {
          expect(passStarts).toEqual([1, 1]);
          expect(view.renderPagesUpto.calls.count()).toBe(2);
          expect(view.renderPagesUpto.calls.allArgs()).toEqual([
            [position, false, context],
            [position, false, context],
          ]);
          expect(result).toEqual({ id: "stable" });
          expect(
            view.resolveChangedRetainedTargetReferences.calls.allArgs(),
          ).toEqual([
            [changedTargetIds, undefined],
            [new Set(), undefined],
          ]);
          expect(view.relayoutingFollowingSpines).toBe(false);
          expect(view.relayoutingFollowingSpineStart).toBeNull();
          done();
        });
    });

    it("rerenders a deferred suffix once after full pagination", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.renderLock = new adapt_epub.RenderLock();
      var finalPosition = {
        spineIndex: 2,
        pageIndex: Number.POSITIVE_INFINITY,
        offsetInItem: -1,
      };
      var initialResult = { id: "initial" };
      var rerenderedResult = { id: "rerendered" };
      var sourcePage = { id: "source", fetchers: [] };
      view.opf = { spine: [{}, {}, {}] };
      view.spineItems = [
        { pages: [sourcePage], instance: { pageNumberOffset: 4 } },
      ];
      view.counterStore = {
        updateTargetCounterNodesInPages: jasmine.createSpy(),
        updateTargetTextNodesInPages: jasmine.createSpy(),
        unresolveReferencesForTargets: function () {},
      };
      view.pageSheetSizeTruncator = jasmine.createSpy("pageSheetSizeTruncator");
      view.deferredFollowingSpineRelayoutStart = 1;
      spyOn(view, "relayoutDeferredFollowingSpines").and.callFake(function () {
        view.deferredFollowingSpineRelayoutStart = null;
      });
      var context = { owner: {} };
      spyOn(view, "renderPagesUpto").and.returnValues(
        Promise.resolve(initialResult),
        Promise.resolve(rerenderedResult),
      );

      view.renderAllPages(context).then(function (result) {
        expect(view.relayoutDeferredFollowingSpines).toHaveBeenCalled();
        expect(view.renderPagesUpto.calls.count()).toBe(2);
        expect(view.renderPagesUpto.calls.allArgs()).toEqual([
          [finalPosition, false, context],
          [finalPosition, false, context],
        ]);
        expect(result).toBe(rerenderedResult);
        expect(
          view.counterStore.updateTargetCounterNodesInPages,
        ).toHaveBeenCalledOnceWith([sourcePage], jasmine.any(Set));
        expect(
          view.counterStore.updateTargetTextNodesInPages,
        ).toHaveBeenCalledOnceWith([sourcePage], jasmine.any(Set));
        expect(view.renderingAllPages).toBe(false);
        expect(view.pageSheetSizeTruncator).toHaveBeenCalledOnceWith(5);
        done();
      });
    });

    it("rerenders an invalidated spine through its end after on-demand pagination", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var position = {
        spineIndex: 2,
        pageIndex: 1,
        offsetInItem: -1,
      };
      var initialResult = { id: "initial" };
      var requestedResult = { id: "requested" };
      var rerenderedResult = { id: "rerendered" };
      var sourcePage = { id: "source", fetchers: [] };
      view.renderLock = new adapt_epub.RenderLock();
      view.renderingAllPages = false;
      view.relayoutingFollowingSpines = false;
      view.spineItems = [
        { pages: [sourcePage], instance: { pageNumberOffset: 4 } },
      ];
      view.counterStore = {
        updateTargetCounterNodesInPages: jasmine.createSpy(),
        updateTargetTextNodesInPages: jasmine.createSpy(),
        unresolveReferencesForTargets: function () {},
      };
      view.pageSheetSizeTruncator = jasmine.createSpy("pageSheetSizeTruncator");
      view.deferredFollowingSpineRelayoutStart = 1;
      var context = { owner: {} };
      spyOn(view, "renderPageTracked").and.returnValues(
        Promise.resolve(initialResult),
        Promise.resolve(requestedResult),
      );
      spyOn(view, "relayoutDeferredFollowingSpines").and.callFake(function () {
        view.deferredFollowingSpineRelayoutStart = null;
        return 2;
      });
      spyOn(view, "renderPagesUpto").and.returnValue(
        Promise.resolve(rerenderedResult),
      );

      view.renderPage(position, context).then(function (result) {
        expect(view.relayoutDeferredFollowingSpines).toHaveBeenCalled();
        expect(view.renderPagesUpto).toHaveBeenCalledWith(
          {
            spineIndex: 2,
            pageIndex: Number.POSITIVE_INFINITY,
            offsetInItem: -1,
          },
          false,
          context,
        );
        expect(view.renderPageTracked.calls.count()).toBe(2);
        expect(result).toBe(requestedResult);
        expect(
          view.counterStore.updateTargetCounterNodesInPages,
        ).toHaveBeenCalledOnceWith([sourcePage], jasmine.any(Set));
        expect(
          view.counterStore.updateTargetTextNodesInPages,
        ).toHaveBeenCalledOnceWith([sourcePage], jasmine.any(Set));
        expect(view.relayoutingFollowingSpines).toBe(false);
        expect(view.renderLock.isHeldByAnother({})).toBe(false);
        expect(view.pageSheetSizeTruncator).toHaveBeenCalledOnceWith(5);
        done();
      });
    });

    it("rerenders every previously rendered spine after on-demand invalidation", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var position = {
        spineIndex: 2,
        pageIndex: Number.POSITIVE_INFINITY,
        offsetInItem: -1,
      };
      var initialResult = { id: "initial" };
      var requestedResult = { id: "requested" };
      var farthestResult = { id: "farthest" };
      var sourcePage = { id: "source", fetchers: [] };
      view.renderLock = new adapt_epub.RenderLock();
      view.renderingAllPages = false;
      view.relayoutingFollowingSpines = false;
      view.spineItems = [
        { pages: [sourcePage], instance: { pageNumberOffset: 4 } },
      ];
      view.counterStore = {
        updateTargetCounterNodesInPages: jasmine.createSpy(),
        updateTargetTextNodesInPages: jasmine.createSpy(),
        unresolveReferencesForTargets: function () {},
      };
      view.pageSheetSizeTruncator = jasmine.createSpy("pageSheetSizeTruncator");
      view.deferredFollowingSpineRelayoutStart = 1;
      var context = { owner: {} };
      spyOn(view, "renderPageTracked").and.returnValues(
        Promise.resolve(initialResult),
        Promise.resolve(requestedResult),
      );
      spyOn(view, "relayoutDeferredFollowingSpines").and.callFake(function () {
        view.deferredFollowingSpineRelayoutStart = null;
        return 4;
      });
      spyOn(view, "renderPagesUpto").and.returnValue(
        Promise.resolve(farthestResult),
      );

      view.renderPage(position, context).then(function (result) {
        expect(view.renderPagesUpto).toHaveBeenCalledOnceWith(
          {
            spineIndex: 4,
            pageIndex: Number.POSITIVE_INFINITY,
            offsetInItem: -1,
          },
          false,
          context,
        );
        expect(view.renderPageTracked.calls.count()).toBe(2);
        expect(result).toBe(requestedResult);
        expect(
          view.counterStore.updateTargetCounterNodesInPages,
        ).toHaveBeenCalledOnceWith([sourcePage], jasmine.any(Set));
        expect(
          view.counterStore.updateTargetTextNodesInPages,
        ).toHaveBeenCalledOnceWith([sourcePage], jasmine.any(Set));
        expect(view.relayoutingFollowingSpines).toBe(false);
        expect(view.renderLock.isHeldByAnother({})).toBe(false);
        expect(view.pageSheetSizeTruncator).toHaveBeenCalledOnceWith(5);
        done();
      });
    });

    it("resolves references deferred by a nested counter scope", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var page = {};
      var viewItem = {};
      view.deferredReferencePages = [];
      var nextLayoutPosition = { page: 16 };
      var ref = {
        isResolved: function () {
          return false;
        },
      };
      view.counterStore = {
        getUnresolvedRefsToPage: function () {
          return [{ refs: [ref] }];
        },
      };
      view.isInCounterResolveScope = function () {
        return false;
      };
      spyOn(view, "resolveUnresolvedReferencesForPage").and.returnValue(
        Promise.resolve(page),
      );

      view
        .resolveDeferredReferencesAfterCounterScope(
          viewItem,
          page,
          15,
          nextLayoutPosition,
        )
        .then(function (result) {
          expect(view.resolveUnresolvedReferencesForPage).toHaveBeenCalledWith(
            viewItem,
            page,
            15,
            nextLayoutPosition,
            undefined,
          );
          expect(result).toBe(page);
          done();
        });
    });

    describe("page type attribute", function () {
      function finishPage(pageType) {
        var view = Object.create(adapt_epub.OPFView.prototype);
        var parent = document.createElement("div");
        var container = document.createElement("div");
        parent.appendChild(container);
        // A stale value from an earlier layout of the same container.
        container.setAttribute("data-vivliostyle-page-type", "stale");
        var page = { container: container, spineIndex: 3, pageType: pageType };
        var viewItem = { pages: [page], item: { spineIndex: 3 } };
        view.opf = { spine: [{}, {}, {}, {}] };
        view.deferredReferencePages = [];
        view.counterStore = {
          getUnresolvedRefsToPage: function () {
            return [];
          },
        };
        view.isInCounterResolveScope = function () {
          return false;
        };
        return view
          .resolveUnresolvedReferencesForPage(viewItem, page, 0, { page: 1 })
          .then(function () {
            return container;
          });
      }

      it("tells the name of a named page", async function () {
        var container = await finishPage("chapter-cover");
        expect(container.getAttribute("data-vivliostyle-page-type")).toBe(
          "chapter-cover",
        );
        expect(container.getAttribute("data-vivliostyle-spine-index")).toBe(
          "3",
        );
      });

      it("has no attribute for the default page type", async function () {
        expect(
          (await finishPage("")).hasAttribute("data-vivliostyle-page-type"),
        ).toBe(false);
        expect(
          (await finishPage(null)).hasAttribute("data-vivliostyle-page-type"),
        ).toBe(false);
      });
    });

    it("remembers the cascaded page where a counter scope defers references", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var page = {
        container: {
          parentElement: {},
          setAttribute: function () {},
          removeAttribute: function () {},
        },
        spineIndex: 0,
      };
      var viewItem = { pages: [page], item: { spineIndex: 0 } };
      view.deferredReferencePages = [];
      var nextLayoutPosition = { page: 1 };
      var ref = {
        isResolved: function () {
          return false;
        },
      };
      view.opf = { spine: [{}, {}] };
      view.counterStore = {
        getUnresolvedRefsToPage: function () {
          return [{ refs: [ref] }];
        },
      };
      view.isInCounterResolveScope = function () {
        return true;
      };
      spyOn(view, "deferReferencesForPage").and.callThrough();

      view
        .resolveUnresolvedReferencesForPage(
          viewItem,
          page,
          0,
          nextLayoutPosition,
        )
        .then(function () {
          expect(view.deferReferencesForPage).toHaveBeenCalledWith(
            viewItem,
            page,
            0,
            nextLayoutPosition,
          );
          done();
        });
    });

    it("queues deferred references until the outermost counter scope is restored", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var page = {};
      var viewItem = { pages: [page] };
      view.deferredReferencePages = [];
      var inCounterScope = true;
      var ref = {
        isResolved: function () {
          return false;
        },
      };
      view.counterStore = {
        getUnresolvedRefsToPage: function () {
          return [{ refs: [ref] }];
        },
      };
      view.isInCounterResolveScope = function () {
        return inCounterScope;
      };
      spyOn(view, "resolveUnresolvedReferencesForPage").and.returnValue(
        Promise.resolve(page),
      );

      view
        .resolveDeferredReferencesAfterCounterScope(viewItem, page, 0, null)
        .then(function () {
          expect(
            view.resolveUnresolvedReferencesForPage,
          ).not.toHaveBeenCalled();
          inCounterScope = false;
          view
            .resolveDeferredReferencesAfterCounterScope(viewItem, page, 0, null)
            .then(function () {
              expect(
                view.resolveUnresolvedReferencesForPage,
              ).toHaveBeenCalledWith(viewItem, page, 0, null, undefined);
              expect(
                view.resolveUnresolvedReferencesForPage.calls.count(),
              ).toBe(1);
              done();
            });
        });
    });

    it("does not requeue a deferred page while draining it", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var page = {};
      var viewItem = { pages: [page] };
      var ref = {
        isResolved: function () {
          return false;
        },
      };
      view.resolvingDeferredReferences = true;
      view.deferredReferencePages = [];
      view.processedDeferredReferencePages = new Map([
        [viewItem, new Set([0])],
      ]);
      view.counterStore = {
        getUnresolvedRefsToPage: function () {
          return [{ spineIndex: 0, refs: [ref] }];
        },
      };

      view.deferReferencesForPage(viewItem, page, 0, null);
      expect(view.deferredReferencePages).toEqual([]);
      done();
    });

    it("drains references cascaded from another deferred page", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var pages = [{ id: "a" }, { id: "b" }, { id: "c" }];
      var viewItem = { pages: pages };
      var ref = {
        isResolved: function () {
          return false;
        },
      };
      view.deferredReferencePages = [];
      view.resolvingDeferredReferences = false;
      view.processedDeferredReferencePages = null;
      view.counterStore = {
        getUnresolvedRefsToPage: function () {
          return [{ refs: [ref] }];
        },
      };
      view.isInCounterResolveScope = function () {
        return false;
      };
      spyOn(view, "resolveUnresolvedReferencesForPage").and.callFake(
        function (item, page, pageIndex) {
          if (pageIndex < pages.length - 1) {
            return view.resolveDeferredReferencesAfterCounterScope(
              item,
              pages[pageIndex + 1],
              pageIndex + 1,
              null,
            );
          }
          return Promise.resolve(page);
        },
      );

      view
        .resolveDeferredReferencesAfterCounterScope(viewItem, pages[0], 0, null)
        .then(function () {
          expect(
            view.resolveUnresolvedReferencesForPage.calls
              .allArgs()
              .map(function (args) {
                return args[2];
              }),
          ).toEqual([0, 1, 2]);
          expect(view.deferredReferencePages).toEqual([]);
          expect(view.processedDeferredReferencePages).toBeNull();
          done();
        });
    });

    it("does not revisit pages already processed by a deferred drain", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var pages = [{ id: "a" }, { id: "b" }];
      var viewItem = { pages: pages };
      var ref = {
        isResolved: function () {
          return false;
        },
      };
      view.deferredReferencePages = [];
      view.resolvingDeferredReferences = false;
      view.processedDeferredReferencePages = null;
      view.counterStore = {
        getUnresolvedRefsToPage: function () {
          return [{ refs: [ref] }];
        },
      };
      view.isInCounterResolveScope = function () {
        return false;
      };
      spyOn(view, "resolveUnresolvedReferencesForPage").and.callFake(
        function (item, page, pageIndex) {
          return view.resolveDeferredReferencesAfterCounterScope(
            item,
            pages[pageIndex === 0 ? 1 : 0],
            pageIndex === 0 ? 1 : 0,
            null,
          );
        },
      );

      view
        .resolveDeferredReferencesAfterCounterScope(viewItem, pages[0], 0, null)
        .then(function () {
          expect(
            view.resolveUnresolvedReferencesForPage.calls
              .allArgs()
              .map(function (args) {
                return args[2];
              }),
          ).toEqual([0, 1]);
          expect(view.deferredReferencePages).toEqual([]);
          expect(view.processedDeferredReferencePages).toBeNull();
          done();
        });
    });

    it("skips references discarded after the resolution worklist was captured", function (done) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      var container = document.createElement("div");
      document.body.appendChild(container);
      var page = new adapt_vtree.Page(container, container);
      page.spineIndex = 0;
      var viewItem = { item: { spineIndex: 0 }, pages: [page] };
      var discardedRef = {
        isResolved: function () {
          return false;
        },
      };
      view.opf = { spine: [{}, {}] };
      view.counterStore = {
        getUnresolvedRefsToPage: function () {
          return [{ spineIndex: 1, pageIndex: 5, refs: [discardedRef] }];
        },
        isReferenceTracked: function () {
          return false;
        },
      };
      view.isInCounterResolveScope = function () {
        return false;
      };
      spyOn(view, "getPageViewItem");

      view
        .resolveUnresolvedReferencesForPage(viewItem, page, 0, { page: 1 })
        .then(function (result) {
          expect(result).toBe(page);
          expect(view.getPageViewItem).not.toHaveBeenCalled();
          container.remove();
          done();
        });
    });
  });
  describe("OPFView pagination progress", function () {
    function createFakeView(totalOffsets) {
      var view = Object.create(adapt_epub.OPFView.prototype);
      view.spineItems = [];
      view.paginationProgress = {
        totalOffsetsBySpine: [],
        renderedOffsetsBySpine: [],
        totalOffsetsReady: false,
        lastReportedPages: 0,
        lastReportedFraction: 0,
      };
      view.opf = {
        spine: totalOffsets.map(function (offset, i) {
          return { src: "doc-" + i, spineIndex: i };
        }),
        store: {
          load: async function (src) {
            var index = Number(src.replace("doc-", ""));
            return {
              getTotalOffset: function () {
                return totalOffsets[index];
              },
            };
          },
        },
      };
      return view;
    }

    function createFakeViewItem(view, spineIndex, totalOffset) {
      return {
        item: view.opf.spine[spineIndex],
        xmldoc: {
          getTotalOffset: function () {
            return totalOffset;
          },
        },
        instance: {
          getPosition: function () {
            return 0;
          },
        },
        pages: [{ fetchers: [] }],
      };
    }

    var payloads;
    var hook = function (payload) {
      payloads.push(payload);
    };

    beforeEach(function () {
      payloads = [];
      vivliostyle_plugin.registerHook(
        vivliostyle_plugin.HOOKS.PAGINATION_PROGRESS,
        hook,
      );
    });

    afterEach(function () {
      vivliostyle_plugin.removeHook(
        vivliostyle_plugin.HOOKS.PAGINATION_PROGRESS,
        hook,
      );
    });

    it("reports the fraction of the paginated content in a single document", function () {
      var view = createFakeView([100]);
      var viewItem = createFakeViewItem(view, 0, 100);
      view.spineItems[0] = viewItem;

      // A page finished at the half of the document
      viewItem.instance.getPosition = function () {
        return 50;
      };
      view.reportPaginationProgress(viewItem, { page: 1 });
      expect(payloads[0].fraction).toBeCloseTo(0.5, 5);
      expect(payloads[0].pages).toBe(1);

      // The last page finished (no next layout position)
      view.reportPaginationProgress(viewItem, null);
      expect(payloads[1].fraction).toBe(1);
    });

    it("does not report 100% until the last of multiple documents is paginated", async function () {
      var view = createFakeView([100, 100, 100]);

      await view.collectTotalOffsets();
      // Each spine item is loaded and fully paginated in order
      for (var i = 0; i < 3; i++) {
        var viewItem = createFakeViewItem(view, i, 100);
        view.spineItems[i] = viewItem;
        view.reportPaginationProgress(viewItem, null);
      }
      expect(payloads[0].fraction).toBeCloseTo(1 / 3, 5);
      expect(payloads[1].fraction).toBeCloseTo(2 / 3, 5);
      expect(payloads[2].fraction).toBe(1);
    });

    it("reports the initial render fraction against the whole publication, not just the first document", function (done) {
      var view = createFakeView([100, 100, 100]);
      // renderSinglePage() dependencies, stubbed to isolate the collect + report
      view.counterStore = { finishPage: function () {} };
      view.isInCounterResolveScope = function () {
        return false;
      };
      view.preparePageCountersForRender = function () {
        return null;
      };
      view.makePage = function () {
        return {
          spineIndex: 0,
          offset: 0,
          fetchers: [],
          embeddedContentFetchers: [],
        };
      };
      view.resolvePageTypeForRenderSlot = function () {};
      view.finishPageContainer = function () {};
      view.maybeRelayoutFollowingPage = function () {
        return Promise.resolve();
      };
      view.resolveUnresolvedReferencesForPage = function (viewItem, page) {
        return Promise.resolve(page);
      };

      var viewItem = createFakeViewItem(view, 0, 100);
      view.spineItems[0] = viewItem;
      viewItem.instance.getPageNumberContextDepth = function () {
        return 0;
      };
      viewItem.instance.pushPageNumberContext = function () {};
      viewItem.instance.restorePageNumberContextDepth = function () {};
      // A page finished at the half of the first document
      viewItem.instance.getPosition = function () {
        return 50;
      };
      viewItem.instance.layoutNextPage = function () {
        return Promise.resolve({ page: 1 });
      };
      view.renderSinglePage(viewItem, { page: 0 }).then(function () {
        expect(payloads[0].fraction).toBeCloseTo(1 / 6, 5);
        done();
      });
    });

    it("waits for the content of object and embed elements before hiding the page", async function () {
      var view = createFakeView([100]);
      var events = [];
      var resolveContent;
      var fetcher = {
        get: function () {
          return new Promise(function (resolve) {
            resolveContent = function () {
              events.push("content loaded");
              resolve(true);
            };
          });
        },
      };
      view.counterStore = { finishPage: function () {} };
      view.isInCounterResolveScope = function () {
        return false;
      };
      view.preparePageCountersForRender = function () {
        return null;
      };
      view.makePage = function () {
        return {
          spineIndex: 0,
          offset: 0,
          fetchers: [fetcher],
          embeddedContentFetchers: [fetcher],
        };
      };
      view.resolvePageTypeForRenderSlot = function () {};
      view.finishPageContainer = function () {
        events.push("page hidden");
      };
      view.maybeRelayoutFollowingPage = function () {
        return Promise.resolve();
      };
      view.resolveUnresolvedReferencesForPage = function (viewItem, page) {
        return Promise.resolve(page);
      };

      var viewItem = createFakeViewItem(view, 0, 100);
      view.spineItems[0] = viewItem;
      viewItem.instance.getPageNumberContextDepth = function () {
        return 0;
      };
      viewItem.instance.pushPageNumberContext = function () {};
      viewItem.instance.restorePageNumberContextDepth = function () {};
      viewItem.instance.getPosition = function () {
        return 50;
      };
      viewItem.instance.layoutNextPage = function () {
        return Promise.resolve({ page: 1 });
      };
      var rendered = view.renderSinglePage(viewItem, { page: 0 });
      await new Promise(function (resolve) {
        setTimeout(resolve, 0);
      });
      expect(events).toEqual([]);
      resolveContent();
      await rendered;
      expect(events).toEqual(["content loaded", "page hidden"]);
    });
  });
});
