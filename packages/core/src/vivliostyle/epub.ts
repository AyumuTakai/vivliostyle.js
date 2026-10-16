/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Daishinsha Inc.
 * Copyright 2018 Vivliostyle Foundation
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
 * @fileoverview Epub - Deal with META-INF/ and .opf files in EPUB container.
 */
import * as Asserts from "./asserts";
import * as Base from "./base";
import * as CFI from "./cfi";
import * as CmykStore from "./cmyk-store";
import * as Constants from "./constants";
import * as Counters from "./counters";
import * as Css from "./css";
import * as CssCascade from "./css-cascade";
import * as CssParser from "./css-parser";
import * as CssTokenizer from "./css-tokenizer";
import * as Exprs from "./exprs";
import * as Font from "./font";
import * as Logging from "./logging";
import * as Net from "./net";
import * as OPS from "./ops";
import * as Plugin from "./plugin";
import * as SemanticFootnote from "./semantic-footnote";
import * as Task from "./task";
import { fromPromise, runLegacy } from "./task-bridge";
import { sleep } from "./task-util";
import * as Toc from "./toc";
import * as Vgen from "./vgen";
import * as Vtree from "./vtree";
import * as XmlDoc from "./xml-doc";

function cloneCounterValues(
  counters: CssCascade.CounterValues,
): CssCascade.CounterValues {
  const result = {} as CssCascade.CounterValues;
  Object.keys(counters).forEach((name) => {
    result[name] = Array.from(counters[name]);
  });
  return result;
}

function clonePageGroupPageCounts(source: {
  [pageType: string]: Map<Element, number>;
}): {
  [pageType: string]: Map<Element, number>;
} {
  const cloned = Object.create(null) as {
    [pageType: string]: Map<Element, number>;
  };
  Object.keys(source).forEach((pageType) => {
    cloned[pageType] = new Map(source[pageType]);
  });
  return cloned;
}

function shouldSkipHeadForWebPub(url: string): boolean {
  return (
    /\.(x?html?|xht|svg)(?:[#?]|$)/i.test(url) ||
    /^(?:about:|data:|blob:)/i.test(Base.stripFragment(url))
  );
}

function encodeURLPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export type Position = {
  spineIndex: number;
  pageIndex: number;
  offsetInItem: number;
};

export class EPUBDocStore extends OPS.OPSDocStore {
  plainXMLStore: XmlDoc.XMLDocStore;
  jsonStore: Net.JSONStore;
  opfByURL: { [key: string]: OPFDoc } = {};
  primaryOPFByEPubURL: { [key: string]: OPFDoc } = {};
  deobfuscators: { [key: string]: Font.Deobfuscator } = {};
  documents: { [key: string]: Promise<XmlDoc.XMLDocHolder | null> } = {};
  /** Resolved values of `documents`, to answer `loadResult` at once. */
  private loadedDocuments: { [key: string]: XmlDoc.XMLDocHolder | null } = {};

  private constructor(
    authorStyleSheets: OPS.StyleSheetParam[] | null = null,
    userStyleSheets: OPS.StyleSheetParam[] | null = null,
  ) {
    super(null, authorStyleSheets, userStyleSheets);
    this.fontDeobfuscator = this.makeDeobfuscatorFactory();
    this.plainXMLStore = XmlDoc.newXMLDocStore();
    this.jsonStore = Net.newJSONStore();
  }

  static create(
    authorStyleSheets: OPS.StyleSheetParam[] | null,
    userStyleSheets: OPS.StyleSheetParam[] | null,
  ): EPUBDocStore {
    const store = new EPUBDocStore(authorStyleSheets, userStyleSheets);
    store.triggerSingleDocumentPreprocessing = true;
    return store;
  }

  makeDeobfuscatorFactory(): Font.DeobfuscatorFactory | null {
    return (url: string): Font.Deobfuscator | null => {
      return this.deobfuscators[url];
    };
  }

  loadAsPlainXML(
    url: string,
    opt_required?: boolean,
    opt_message?: string,
  ): Promise<XmlDoc.XMLDocHolder> {
    return this.plainXMLStore.load(
      url,
      opt_required,
      opt_message,
    ) as Promise<XmlDoc.XMLDocHolder>;
  }

  startLoadingAsPlainXML(url: string): void {
    this.plainXMLStore.fetch(url);
  }

  loadAsJSON(
    url: string,
    opt_required?: boolean,
    opt_message?: string,
  ): Promise<Base.JSON> {
    return this.jsonStore.load(url, opt_required, opt_message);
  }

  async loadWebPubManifest(url: string): Promise<OPFDoc | null> {
    const manifestObj = await this.loadAsJSON(url, true);
    if (!manifestObj) {
      this.reportLoadError(url);
      return null;
    }
    return OPFDoc.fromWebPubManifest(this, url, manifestObj, undefined, url);
  }

  async loadPubDoc(url: string): Promise<OPFDoc | null> {
    if (/\.opf(?:[#?]|$)/i.test(url)) {
      // EPUB OPF
      const [, pubURL, root] = url.match(/^((?:.*\/)?)([^/]*)$/);
      return this.loadOPF(pubURL, root);
    }
    if (/\.json(?:ld)?(?:[#?]|$)/i.test(url)) {
      // Web Publication Manifest
      return this.loadWebPubManifest(url);
    }
    if (shouldSkipHeadForWebPub(url)) {
      // Web Publication primary entry (X)HTML
      // Skip HEAD request for known document URLs and special schemes.
      // Browsers reject non-GET methods for data: and blob: URLs.
      const opf = await this.loadWebPub(url);
      if (opf) {
        return opf;
      }
      // These URLs cannot be the root of an unzipped EPUB container.
      this.reportLoadError(url);
      return null;
    }

    // For ambiguous URLs (no recognized extension), use HEAD to check
    // content type and availability before loading.
    const response = await Net.fetchFromURL(url, undefined, "HEAD");
    if (response.status >= 400) {
      // This url can be the root of an unzipped EPUB.
      const opf = await this.loadEPUBDoc(url);
      if (opf) {
        return opf;
      }
      Logging.logger.error(
        `Failed to fetch a source document from ${url} (${response.status}${
          response.statusText ? " " + response.statusText : ""
        })`,
      );
      return null;
    }
    if (
      !response.status &&
      !response.responseXML &&
      !response.responseText &&
      !response.responseBlob &&
      !response.contentType
    ) {
      // Empty response
      if (/\/[^/.]+(?:[#?]|$)/.test(url)) {
        // Adding trailing "/" may solve the problem.
        url = url.replace(/([#?]|$)/, "/$1");
      } else {
        // Ignore empty response of HEAD request, it may become OK with GET request.
      }
    }
    if (response.contentType == "application/oebps-package+xml") {
      // EPUB OPF (served with OPF content type but without .opf extension)
      const [, pubURL, root] = url.match(/^((?:.*\/)?)([^/]*)$/);
      return this.loadOPF(pubURL, root);
    }
    if (
      response.contentType == "application/ld+json" ||
      response.contentType == "application/webpub+json" ||
      response.contentType == "application/audiobook+json" ||
      response.contentType == "application/json"
    ) {
      // Web Publication Manifest (served with JSON content type)
      return this.loadWebPubManifest(url);
    }
    // Web Publication primary entry (X)HTML
    const webPub = await this.loadWebPub(url);
    if (webPub) {
      return webPub;
    }
    // This url can be the root of an unzipped EPUB.
    const epub = await this.loadEPUBDoc(url);
    if (epub) {
      return epub;
    }
    this.reportLoadError(url);
    return null;
  }

  async loadEPUBDoc(url: string): Promise<OPFDoc | null> {
    if (!url.endsWith("/")) {
      url = url + "/";
    }
    this.startLoadingAsPlainXML(url + "META-INF/encryption.xml");
    const containerURL = url + "META-INF/container.xml";
    const containerXML = await this.loadAsPlainXML(containerURL);
    if (containerXML) {
      const roots = containerXML
        .doc()
        .child("container")
        .child("rootfiles")
        .child("rootfile")
        .attribute("full-path");
      for (const root of roots) {
        if (root) {
          return this.loadOPF(url, root);
        }
      }
    }
    return null;
  }

  async loadOPF(pubURL: string, root: string): Promise<OPFDoc | null> {
    const url = pubURL + root;
    const opf = this.opfByURL[url];
    if (opf) {
      return opf;
    }
    const opfXML = await this.loadAsPlainXML(
      url,
      true,
      `Failed to fetch EPUB OPF ${url}`,
    );
    if (!opfXML) {
      this.reportLoadError(url);
      // The former implementation never finished here: the caller was left
      // waiting. Report the failure to the caller instead.
      throw new Error(`Failed to load EPUB OPF ${url}`);
    }
    let encXML: XmlDoc.XMLDocHolder | null = null;
    if (this.plainXMLStore.resources[pubURL + "META-INF/container.xml"]) {
      encXML = await this.loadAsPlainXML(pubURL + "META-INF/encryption.xml");
    }
    // else, OPF file is directly specified, not via container.xml.
    // In this case, encryption.xml is not available.
    const loaded = OPFDoc.fromXMLDoc(this, pubURL, opfXML, encXML);
    this.opfByURL[url] = loaded;
    this.primaryOPFByEPubURL[pubURL] = loaded;
    return loaded;
  }

  async loadWebPub(url: string): Promise<OPFDoc | null> {
    // Load the primary entry page (X)HTML
    const xmldoc = await this.load(url);
    if (!xmldoc) {
      this.reportLoadError(url);
      return null;
    }
    if (
      xmldoc.document.querySelector("a[href='META-INF/'],a[href$='/META-INF/']")
    ) {
      // This is likely the directory listing of unzipped EPUB top directory
      return null;
    }
    const doc = xmldoc.document;

    // Find manifest, W3C WebPublication or Readium Web Publication Manifest
    const manifestLink = doc.querySelector(
      "link[rel='publication'],link[rel='manifest'][type='application/webpub+json']",
    );
    if (manifestLink) {
      const href = manifestLink.getAttribute("href");
      if (href?.startsWith("#")) {
        const manifestObj = Base.stringToJSON(
          doc.getElementById(href.slice(1)).textContent,
        );
        return OPFDoc.fromWebPubManifest(this, url, manifestObj, doc);
      }
      const manifestUrl = Base.resolveURL(
        manifestLink.getAttribute("href"),
        url,
      );
      const manifestObj = await this.loadAsJSON(
        manifestUrl,
        true,
        `Failed to fetch Publication Manifest ${manifestUrl}`,
      );
      return OPFDoc.fromWebPubManifest(
        this,
        url,
        manifestObj,
        doc,
        manifestUrl,
      );
    }
    // No manifest
    const opf = await OPFDoc.fromWebPubManifest(this, url, {}, doc);
    if (opf.toc && opf.toc.src === xmldoc.url) {
      // toc is the primary entry (X)HTML
      if (Toc.findTocElements(doc).length === 0) {
        // TOC is not found in the primary entry (X)HTML
        opf.toc = null;
      }
    }
    return opf;
  }

  addDocument(url: string, doc: Document): Promise<XmlDoc.XMLDocHolder | null> {
    const docURL = Base.stripFragment(url);
    const r = (this.documents[docURL] = this.parseOPSResource({
      status: 200,
      statusText: "",
      url: docURL,
      contentType: (doc as any).contentType,
      responseText: null,
      responseXML: doc,
      responseBlob: null,
    }));
    r.then((xmldoc) => {
      this.loadedDocuments[docURL] = xmldoc;
    });
    return r;
  }

  reportLoadError(docURL: string): void {
    const removePath = (url: string) => {
      return url.replace(/([^:/?#]|^)[/?#].*/, "$1");
    };
    const likelyCorsProblem = () => {
      const domain = removePath(docURL);
      if (domain === removePath(Base.baseURL)) {
        // same domain, no CORS problem
        return false;
      }
      const urls = Object.keys(this.resources);
      if (
        urls.find((url) => this.resources[url] && removePath(url) === domain)
      ) {
        // if there is an already loaded resource with the same domain, no CORS problem
        return false;
      }
      if (!/^https?:?\/\/[^/]/.test(docURL)) {
        // not a valid URL
        return false;
      }
      if (/\.(xhtml|xht|xml|opf)$/i.test(docURL)) {
        // maybe, XML error
        return false;
      }
      // likely, CORS problem
      return true;
    };

    if (docURL.startsWith("data:")) {
      Logging.logger.error(`Failed to load ${docURL}. Invalid data.`);
    } else if (
      docURL.startsWith("http:") &&
      Base.baseURL.startsWith("https:") &&
      // Browsers allow http://localhost from https:// (no mixed content block);
      // the real error there is CORS, handled by likelyCorsProblem() below.
      !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(?:[/?#]|$)/.test(
        docURL,
      )
    ) {
      Logging.logger.error(
        `Failed to load ${docURL}. Mixed Content ("http:" content on "https:" context) is not allowed.`,
      );
    } else if (likelyCorsProblem()) {
      Logging.logger.error(
        `Failed to load ${docURL}. This may be caused by network error, incorrect URL, or the server not allowing cross-origin resource sharing (CORS).`,
      );
    } else {
      Logging.logger.error(
        `Failed to load ${docURL}. The target resource is invalid.`,
      );
    }
  }

  override async load(url: string): Promise<XmlDoc.XMLDocHolder> {
    const docURL = Base.stripFragment(url);
    const r = this.documents[docURL];
    if (r) {
      return r;
    }
    const xmldoc = await super.load(
      docURL,
      true,
      `Failed to fetch a source document from ${docURL}`,
    );
    if (!xmldoc) {
      this.reportLoadError(docURL);
      // The former implementation never finished here: the caller was left
      // waiting. Report the failure to the caller instead.
      throw new Error(`Failed to load ${docURL}`);
    }
    return xmldoc;
  }

  override loadResult(url: string): Task.Result<XmlDoc.XMLDocHolder> {
    const docURL = Base.stripFragment(url);
    if (docURL in this.loadedDocuments) {
      return Task.newResult(this.loadedDocuments[docURL]);
    }
    return super.loadResult(
      docURL,
      true,
      `Failed to fetch a source document from ${docURL}`,
    );
  }

  override processViewportMeta(meta: Element): string {
    let content = meta.getAttribute("content");
    if (!content) {
      return "";
    }
    const vals = {};
    let r: RegExpMatchArray | null;
    while (
      (r = content.match(
        /^,?\s*([-A-Za-z_.][-A-Za-z_0-9.]*)\s*=\s*([-+A-Za-z_0-9.]*)\s*/,
      )) != null
    ) {
      content = content.slice(r[0].length);
      vals[r[1]] = r[2];
    }
    const width = vals["width"] - 0;
    const height = vals["height"] - 0;
    if (width && height) {
      const prePaginated = !!Object.values(this.primaryOPFByEPubURL).find(
        (opf) => opf.prePaginated,
      );
      return (
        `@-epubx-viewport{width:${width}px;height:${height}px;}` +
        (prePaginated
          ? `@page{size:${width}px ${height}px;margin:0;}`
          : `@page{margin:0;}`)
      );
    }
    return "";
  }
}

export type OPFItemParam = {
  url: string;
  index: number;
  startPage: number | null;
  skipPagesBefore: number | null;
};

export class OPFItem {
  id: string | null = null;
  src: string = "";
  mediaType: string | null = null;
  title: string | null = null;
  itemRefElement: Element | null = null;
  spineIndex: number = -1;
  compressedSize: number = 0;
  compressed: boolean | null = null;
  epage: number = 0;
  epageCount: number = 0;
  startPage: number | null = null;
  skipPagesBefore: number | null = null;
  itemProperties: { [key: string]: boolean };

  constructor() {
    this.itemProperties = Base.emptyObj;
  }

  initWithElement(itemElem: Element, opfURL: string): void {
    this.id = itemElem.getAttribute("id");
    this.src = Base.resolveURL(itemElem.getAttribute("href"), opfURL);
    this.mediaType = itemElem.getAttribute("media-type");
    const propStr = itemElem.getAttribute("properties");
    if (propStr) {
      this.itemProperties = Base.arrayToSet(propStr.split(/\s+/));
    }
  }

  initWithParam(param: OPFItemParam) {
    this.spineIndex = param.index;
    this.id = `item${param.index + 1}`;
    this.src = param.url;
    this.startPage = param.startPage;
    this.skipPagesBefore = param.skipPagesBefore;
  }
}

export function getOPFItemId(item: OPFItem): string | null {
  return item.id;
}

export function makeDeobfuscator(uid: string): Font.Deobfuscator {
  return async (blob) => {
    const hash = await makeDigest("SHA-1", uid);
    const head = blob.slice(0, 1040);
    const tail = blob.slice(1040, blob.size);
    const buf = await Net.readBlob(head);
    const dataView = new DataView(buf);
    for (let k = 0; k < dataView.byteLength; k++) {
      let b = dataView.getUint8(k);
      b ^= hash[k % 20];
      dataView.setUint8(k, b);
    }
    return Net.makeBlob([dataView, tail]);
  };
}

async function makeDigest(algorithm: string, str: string): Promise<Uint8Array> {
  const buf = await window.crypto.subtle.digest(
    algorithm,
    new TextEncoder().encode(str),
  );
  return new Uint8Array(buf);
}

type RawMeta = {
  [key: string]: RawMetaItem[];
};

type RawMetaItem = {
  name: string;
  value: string;
  id: string | null;
  refines: string | null;
  scheme: string | null;
  lang: string | null;
  order: number;
  role: string | null;
};

export interface Meta {
  [key: string]: MetaItem[];
}

export interface MetaItem {
  v: string;
  o?: number;
  s?: string;
  r?: Meta;
}

export const predefinedPrefixes = {
  dcterms: "http://purl.org/dc/terms/",
  marc: "http://id.loc.gov/vocabulary/",
  media: "http://www.idpf.org/epub/vocab/overlays/#",
  rendition: "http://www.idpf.org/vocab/rendition/#",
  onix: "http://www.editeur.org/ONIX/book/codelists/current.html#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  opf: "http://www.idpf.org/2007/opf",
};

export const defaultIRI = "http://idpf.org/epub/vocab/package/meta/#";

export const metaTerms = {
  language: `${predefinedPrefixes["dcterms"]}language`,
  title: `${predefinedPrefixes["dcterms"]}title`,
  creator: `${predefinedPrefixes["dcterms"]}creator`,
  layout: `${predefinedPrefixes["rendition"]}layout`,
  titleType: `${defaultIRI}title-type`,
  displaySeq: `${defaultIRI}display-seq`,
  alternateScript: `${defaultIRI}alternate-script`,
  role: `${defaultIRI}role`,
};

export function getMetadataComparator(
  term: string,
  lang: string | null,
): (p1: MetaItem, p2: MetaItem) => number {
  const empty = {};
  return (item1, item2) => {
    let m1: boolean;
    let m2: boolean;
    const r1 = item1["r"] || empty;
    const r2 = item2["r"] || empty;
    if (term == metaTerms.title) {
      m1 = r1[metaTerms.titleType]?.[0].v == "main";
      m2 = r2[metaTerms.titleType]?.[0].v == "main";
      if (m1 != m2) {
        return m1 ? -1 : 1;
      }
    }
    let i1 = parseInt(r1[metaTerms.displaySeq]?.[0].v, 10);
    if (isNaN(i1)) {
      i1 = Number.MAX_VALUE;
    }
    let i2 = parseInt(r2[metaTerms.displaySeq]?.[0].v, 10);
    if (isNaN(i2)) {
      i2 = Number.MAX_VALUE;
    }
    if (i1 != i2) {
      return i1 - i2;
    }
    if (term != metaTerms.language && lang) {
      m1 =
        (r1[metaTerms.language] || r1[metaTerms.alternateScript])?.[0].v ==
        lang;
      m2 =
        (r2[metaTerms.language] || r2[metaTerms.alternateScript])?.[0].v ==
        lang;
      if (m1 != m2) {
        return m1 ? -1 : 1;
      }
    }
    return item1["o"] - item2["o"];
  };
}

export function readMetadata(
  mroot: XmlDoc.NodeList,
  prefixes: string | null,
): Meta {
  // Parse prefix map (if any)
  let prefixMap;
  if (!prefixes) {
    prefixMap = predefinedPrefixes;
  } else {
    prefixMap = {};
    for (const pn in predefinedPrefixes) {
      prefixMap[pn] = predefinedPrefixes[pn];
    }
    let r: RegExpMatchArray | null;

    // This code permits any non-ASCII characters in the name to avoid bloating
    // the pattern.
    while (
      (r = prefixes.match(
        /^\s*([A-Z_a-z\u007F-\uFFFF][-.A-Z_a-z0-9\u007F-\uFFFF]*):\s*(\S+)/,
      )) != null
    ) {
      prefixes = prefixes.slice(r[0].length);
      prefixMap[r[1]] = r[2];
    }
  }
  const resolveProperty = (val: string | null): string | null => {
    if (val) {
      const r = val.match(/^\s*(([^:]*):)?(\S+)\s*$/);
      if (r) {
        const iri = r[2] ? prefixMap[r[2]] : defaultIRI;
        if (iri) {
          return iri + r[3];
        }
      }
    }
    return null;
  };
  let order = 1;

  // List of metadata items.
  const rawItems = mroot.childElements().forEachNonNull((node: Element) => {
    if (node.localName == "meta") {
      const p = resolveProperty(node.getAttribute("property"));
      if (p) {
        return {
          name: p,
          value: node.textContent,
          id: node.getAttribute("id"),
          order: order++,
          refines: node.getAttribute("refines"),
          lang: null,
          scheme: resolveProperty(node.getAttribute("scheme")),
          role: null,
        };
      }
    } else if (node.namespaceURI == Base.NS.DC) {
      return {
        name: predefinedPrefixes["dcterms"] + node.localName,
        order: order++,
        lang: node.getAttribute("xml:lang"),
        value: node.textContent,
        id: node.getAttribute("id"),
        refines: null,
        scheme: null,
        role: node.getAttribute("role") || node.getAttribute("opf:role"),
      };
    }
    return null;
  });

  // Items grouped by their target id.
  const rawItemsByTarget = Base.multiIndexArray(
    rawItems,
    (rawItem) => rawItem.refines,
  );
  const makeMetadata = (map: RawMeta): Meta =>
    Base.mapObj(map, (rawItemArr, _itemName) =>
      rawItemArr.map((rawItem) => {
        const entry = { v: rawItem.value, o: rawItem.order };
        if (rawItem.scheme) {
          entry["s"] = rawItem.scheme;
        }
        let refs = rawItemsByTarget[`#${rawItem.id}`] || [];
        if (refs.length || rawItem.lang || rawItem.role) {
          if (rawItem.lang) {
            // Special handling for xml:lang
            refs.push({
              name: metaTerms.language,
              value: rawItem.lang,
              lang: null,
              id: null,
              refines: rawItem.id,
              scheme: null,
              order: rawItem.order,
              role: null,
            });
          }
          if (rawItem.role) {
            // Special handling for opf:role
            refs.push({
              name: metaTerms.role,
              value: rawItem.role,
              lang: null,
              id: null,
              refines: rawItem.id,
              scheme: null,
              order: rawItem.order,
              role: null,
            });
          }
          const entryMap = Base.multiIndexArray(
            refs,
            (rawItem) => rawItem.name,
          );
          entry["r"] = makeMetadata(entryMap);
        }
        return entry;
      }),
    );
  const metadata = makeMetadata(
    Base.multiIndexArray(rawItems, (rawItem) =>
      rawItem.refines ? null : rawItem.name,
    ),
  );
  let lang: string | null = null;
  if (metadata[metaTerms.language]) {
    lang = metadata[metaTerms.language][0]["v"];
  }
  const sortMetadata = (metadata: Meta) => {
    for (const term in metadata) {
      const arr = metadata[term];
      arr.sort(getMetadataComparator(term, lang));
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i]["r"];
        if (r) {
          sortMetadata(r);
        }
      }
    }
  };
  sortMetadata(metadata);
  return metadata;
}

export function getMathJaxHub(): object | null {
  const math = window["MathJax"];
  if (math) {
    return math["Hub"];
  }
  return null;
}

export const supportedMediaTypes = {
  "application/xhtml+xml": true,
  "image/jpeg": true,
  "image/png": true,
  "image/svg+xml": true,
  "image/gif": true,
  "audio/mp3": true,
};

export const transformedIdPrefix = "viv-id-";

function getPathFromURL(url: string, pubURL: string): string | null {
  if (url.startsWith("data:")) {
    return url === pubURL ? "" : url;
  }
  if (pubURL) {
    let epubBaseURL = Base.resolveURL("", pubURL);
    if (url === epubBaseURL || url + "/" === epubBaseURL) {
      return "";
    }
    if (!epubBaseURL.endsWith("/")) {
      epubBaseURL += "/";
    }
    return url.startsWith(epubBaseURL)
      ? decodeURIComponent(url.slice(epubBaseURL.length))
      : null;
  } else {
    return url;
  }
}

export class OPFDoc {
  opfXML: XmlDoc.XMLDocHolder;
  items: OPFItem[];
  spine: OPFItem[];
  itemMap: { [key: string]: OPFItem };
  itemMapByPath: { [key: string]: OPFItem };
  bindings: { [key: string]: string } = {};
  lang: string | null = null;
  epageCount: number = 0;
  prePaginated: boolean = false;
  epageIsRenderedPage: boolean = true;
  epageCountCallback: ((p1: number) => void) | null = null;
  metadata: Meta = {};
  toc: OPFItem | null = null;
  cover: OPFItem | null = null;
  fallbackMap: { [key: string]: string } = {};
  pageProgression: Constants.PageProgression | null = null;
  documentURLTransformer: Base.DocumentURLTransformer;

  private constructor(
    public readonly store: EPUBDocStore,
    public readonly pubURL: string,
    content: {
      opfXML: XmlDoc.XMLDocHolder;
      items: OPFItem[];
      spine: OPFItem[];
      itemMap: { [key: string]: OPFItem };
      itemMapByPath: { [key: string]: OPFItem };
    },
  ) {
    this.opfXML = content.opfXML;
    this.items = content.items;
    this.spine = content.spine;
    this.itemMap = content.itemMap;
    this.itemMapByPath = content.itemMapByPath;
    this.documentURLTransformer = this.createDocumentURLTransformer();
  }

  // FIXME: TS4055
  createDocumentURLTransformer(): Base.DocumentURLTransformer {
    const self = this;
    class OPFDocumentURLTransformer implements Base.DocumentURLTransformer {
      private canonicalDocumentURLCache = new Map<string, string>();

      private getCanonicalDocumentURL(url: string): string {
        // Issue #2036: a server may redirect a spine item URL (for example,
        // stripping `.html`). Canonicalize redirected aliases back to the
        // spine source URL so transformed ids and same-document references use
        // one stable document identity.
        const strippedURL = Base.stripFragment(Base.stripTocBoxURL(url));
        const cachedURL = this.canonicalDocumentURLCache.get(strippedURL);
        if (cachedURL) {
          return cachedURL;
        }
        for (const item of self.spine) {
          const itemURL = Base.stripFragment(Base.stripTocBoxURL(item.src));
          if (itemURL === strippedURL) {
            this.canonicalDocumentURLCache.set(strippedURL, itemURL);
            return itemURL;
          }
          const loadedURL = self.store?.get(itemURL)?.url;
          if (
            loadedURL &&
            Base.stripFragment(Base.stripTocBoxURL(loadedURL)) === strippedURL
          ) {
            this.canonicalDocumentURLCache.set(strippedURL, itemURL);
            return itemURL;
          }
        }
        this.canonicalDocumentURLCache.set(strippedURL, strippedURL);
        return strippedURL;
      }

      /** @override */
      transformFragment(fragment: string, baseURL: string): string {
        const canonicalBaseURL = this.getCanonicalDocumentURL(baseURL);
        const url = canonicalBaseURL + (fragment ? `#${fragment}` : "");
        return transformedIdPrefix + Base.escapeNameStrToHex(url, ":");
      }

      /** @override */
      transformURL(url: string, baseURL: string): string {
        const r = url.match(/^([^#]*)#?(.*)$/);
        if (r) {
          const path = this.getCanonicalDocumentURL(
            r[1] || Base.stripTocBoxURL(baseURL),
          );
          const fragment = decodeURIComponent(r[2]);
          if (path) {
            if (
              self.spine.some(
                (item) =>
                  Base.stripFragment(Base.stripTocBoxURL(item.src)) === path,
              )
            ) {
              return `#${this.transformFragment(fragment, path)}`;
            }
          }
        }
        return url;
      }

      /** @override */
      restoreURL(encoded: string): string[] {
        if (encoded.startsWith("#")) {
          encoded = encoded.substring(1);
        }
        if (encoded.startsWith(transformedIdPrefix)) {
          encoded = encoded.substring(transformedIdPrefix.length);
        }
        const decoded = Base.unescapeStrFromHex(encoded, ":");
        const r = decoded.match(/^([^#]*)#?(.*)$/);
        return r ? [r[1], r[2]] : [];
      }
    }
    return new OPFDocumentURLTransformer();
  }

  /**
   * Metadata is organized in the following way: fully-expanded property names
   * (with IRI prefixes prepended) point to an array of values. Array contains
   * at least one element. First element is primary and should be used by
   * default. Element values are objects have the following keys:
   * - "v" - item value as string,
   * - "s" - scheme,
   * - "o" - index in the order of appearing in the source,
   * - "r" - refinement submetadata (organized just like the top-level
   * metadata).
   */
  getMetadata(): Meta {
    return this.metadata;
  }

  getPathFromURL(url: string): string | null {
    return getPathFromURL(url, this.pubURL);
  }

  static fromXMLDoc(
    store: EPUBDocStore,
    pubURL: string,
    opfXML: XmlDoc.XMLDocHolder,
    encXML: XmlDoc.XMLDocHolder | null,
  ): OPFDoc {
    const pkg = opfXML.doc().child("package");
    let uid: string | null = null;
    const uidref = pkg.attribute("unique-identifier")[0];
    if (uidref) {
      const uidElem = opfXML.getElement(`${opfXML.url}#${uidref}`);
      if (uidElem) {
        uid = uidElem.textContent.replace(/[ \n\r\t]/g, "");
      }
    }
    const srcToFallbackId = {};
    let toc: OPFItem | null = null;
    let cover: OPFItem | null = null;
    const items = pkg
      .child("manifest")
      .child("item")
      .asArray()
      .map((node) => {
        const item = new OPFItem();
        const elem = node as Element;
        item.initWithElement(elem, opfXML.url);
        const fallback = elem.getAttribute("fallback");
        if (fallback && !supportedMediaTypes[item.mediaType]) {
          srcToFallbackId[item.src] = fallback;
        }
        if (!toc && item.itemProperties["nav"]) {
          toc = item;
        }
        if (!cover && item.itemProperties["cover-image"]) {
          cover = item;
        }
        return item;
      });
    const itemMap = Base.indexArray(
      items,
      getOPFItemId as (p1: OPFItem) => string | null,
    );
    const itemMapByPath = Base.indexArray(items, (item) =>
      getPathFromURL(item.src, pubURL),
    );
    const fallbackMap: { [key: string]: string } = {};
    for (const src in srcToFallbackId) {
      let fallbackSrc = src;
      while (true) {
        const item = itemMap[srcToFallbackId[fallbackSrc]];
        if (!item) {
          break;
        }
        if (supportedMediaTypes[item.mediaType]) {
          fallbackMap[src] = item.src;
          break;
        }
        fallbackSrc = item.src;
      }
    }
    const spine = pkg
      .child("spine")
      .child("itemref")
      .asArray()
      .map((node, index) => {
        const elem = node as Element;
        const id = elem.getAttribute("idref");
        const item = itemMap[id as string];
        if (item) {
          item.itemRefElement = elem;
          item.spineIndex = index;
        }
        return item;
      });
    const opf = new OPFDoc(store, pubURL, {
      opfXML,
      items,
      spine,
      itemMap,
      itemMapByPath,
    });
    opf.toc = toc;
    opf.cover = cover;
    opf.fallbackMap = fallbackMap;
    const pageProgressionAttr = pkg
      .child("spine")
      .attribute("page-progression-direction")[0];
    if (pageProgressionAttr) {
      opf.pageProgression = Constants.pageProgressionOf(pageProgressionAttr);
    }
    const idpfObfURLs = !encXML
      ? []
      : encXML
          .doc()
          .child("encryption")
          .child("EncryptedData")
          .predicate(
            XmlDoc.predicate.withChild(
              "EncryptionMethod",
              XmlDoc.predicate.withAttribute(
                "Algorithm",
                "http://www.idpf.org/2008/embedding",
              ),
            ),
          )
          .child("CipherData")
          .child("CipherReference")
          .attribute("URI");
    const mediaTypeElems = pkg
      .child("bindings")
      .child("mediaType")
      .asArray() as Element[];
    for (let i = 0; i < mediaTypeElems.length; i++) {
      const handlerId = mediaTypeElems[i].getAttribute("handler");
      const mediaType = mediaTypeElems[i].getAttribute("media-type");
      if (mediaType && handlerId && itemMap[handlerId]) {
        opf.bindings[mediaType] = itemMap[handlerId].src;
      }
    }
    opf.metadata = readMetadata(
      pkg.child("metadata"),
      pkg.attribute("prefix")[0],
    );
    if (opf.metadata[metaTerms.language]) {
      opf.lang = opf.metadata[metaTerms.language][0]["v"];
    }
    if (opf.metadata[metaTerms.layout]) {
      opf.prePaginated =
        opf.metadata[metaTerms.layout][0]["v"] === "pre-paginated";
    }

    if (idpfObfURLs.length > 0 && uid) {
      // Have to deobfuscate in JavaScript
      const deobfuscator = makeDeobfuscator(uid);
      for (let i = 0; i < idpfObfURLs.length; i++) {
        store.deobfuscators[pubURL + idpfObfURLs[i]] = deobfuscator;
      }
    }
    if (opf.prePaginated) {
      opf.assignAutoPages();
    }
    return opf;
  }

  assignAutoPages(): void {
    let epage = 0;
    for (const item of this.spine) {
      const epageCount = this.prePaginated
        ? 1
        : Math.ceil(item.compressedSize / 1024);
      item.epage = epage;
      item.epageCount = epageCount;
      epage += epageCount;
    }
    this.epageCount = epage;

    this.epageCountCallback?.(this.epageCount);
  }

  setEPageCountMode(epageIsRenderedPage: boolean) {
    this.epageIsRenderedPage = epageIsRenderedPage || this.prePaginated;
  }

  /**
   * Counts the estimated pages ("epage") of all the spine items, and reports
   * the count so far to the callback after each item. Stops with the reason
   * of `signal` if it is aborted.
   */
  async countEPages(
    epageCountCallback: ((p1: number) => void) | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.epageCountCallback = epageCountCallback;

    if (this.epageIsRenderedPage) {
      if (this.prePaginated && this.epageCount == 0) {
        this.assignAutoPages();
      }
      return true;
    }

    let epage = 0;
    for (let i = 0; i < this.spine.length; i++) {
      signal?.throwIfAborted();
      const item = this.spine[i];
      item.epage = epage;
      const xmldoc = await this.store.load(item.src);
      signal?.throwIfAborted();
      if (!xmldoc) {
        continue;
      }
      // According to the old comment,
      // "Estimate that offset=2700 roughly corresponds to 1024 bytes of compressed size."
      // However, it should depend on the language.
      // Further adjustment needed.

      //let offsetPerEPage = 2700;
      let offsetPerEPage = 1800;
      const lang = xmldoc.lang || this.lang;
      if (lang && lang.match(/^(ja|ko|zh)/)) {
        offsetPerEPage /= 3;
      }
      item.epageCount = Math.ceil(xmldoc.getTotalOffset() / offsetPerEPage);
      epage += item.epageCount;
      this.epageCount = epage;
      this.epageCountCallback?.(this.epageCount);
    }
    return true;
  }

  private static buildChapters(
    pubURL: string,
    params: OPFItemParam[],
  ): {
    opfXML: XmlDoc.XMLDocHolder;
    items: OPFItem[];
    spine: OPFItem[];
    itemMap: { [key: string]: OPFItem };
    itemMapByPath: { [key: string]: OPFItem };
  } {
    const itemMap: { [key: string]: OPFItem } = {};
    const itemMapByPath: { [key: string]: OPFItem } = {};
    const items: OPFItem[] = [];
    const spine = items;

    // create a minimum fake OPF XML for navigation with EPUB CFI
    const opfXML = new XmlDoc.XMLDocHolder(
      null,
      "",
      new DOMParser().parseFromString("<spine></spine>", "text/xml"),
    );
    params.forEach((param) => {
      const item = new OPFItem();
      item.initWithParam(param);
      Asserts.assert(item.id);
      const itemref = opfXML.document.createElement("itemref");
      itemref.setAttribute("idref", item.id);
      opfXML.root.appendChild(itemref);
      item.itemRefElement = itemref;
      itemMap[item.id] = item;
      let path = getPathFromURL(param.url, pubURL);
      if (path == null) {
        path = param.url;
      }
      itemMapByPath[path] = item;
      items.push(item);
    });
    return { opfXML, items, spine, itemMap, itemMapByPath };
  }

  /**
   * Creates a fake OPF "document" that contains OPS chapters.
   */
  static async fromChapters(
    store: EPUBDocStore,
    pubURL: string,
    params: OPFItemParam[],
    doc?: Document | null,
  ): Promise<OPFDoc> {
    const opf = new OPFDoc(store, pubURL, OPFDoc.buildChapters(pubURL, params));
    if (doc) {
      await store.addDocument(params[0].url, doc);
    }
    return opf;
  }

  static async fromWebPubManifest(
    store: EPUBDocStore,
    pubURL: string,
    manifestObj: Base.JSON,
    doc?: Document,
    manifestUrl?: string,
  ): Promise<OPFDoc> {
    let pageProgression: Constants.PageProgression | null = null;
    if (manifestObj["readingProgression"]) {
      pageProgression = manifestObj["readingProgression"];
    }
    const metadata: Meta = {};
    const title =
      manifestObj["name"] || manifestObj["metadata"]?.["title"] || doc?.title;
    if (title) {
      metadata[metaTerms.title] = (Array.isArray(title) ? title : [title]).map(
        (item) => ({ v: item.value ?? item }),
      );
    }
    const author =
      manifestObj["author"] ||
      manifestObj["creator"] ||
      manifestObj["metadata"]?.["author"] ||
      Array.from(
        doc?.querySelectorAll("meta[name='author'], meta[name='DC.Creator']") ??
          [],
      ).map((meta: HTMLMetaElement) => meta.content);
    if (author && author.length !== 0) {
      metadata[metaTerms.creator] = (
        Array.isArray(author) ? author : [author]
      ).map((item) => ({ v: item.name ?? item }));
    }
    const language =
      manifestObj["inLanguage"] ||
      manifestObj["metadata"]?.["language"] ||
      doc?.documentElement.lang ||
      doc?.documentElement.getAttribute("xml:lang");
    if (language) {
      metadata[metaTerms.language] = (
        Array.isArray(language) ? language : [language]
      ).map((item) => ({ v: item }));
    }
    // TODO: other metadata...

    const primaryEntryURL = Base.stripFragment(pubURL);
    const primaryEntryPath = getPathFromURL(primaryEntryURL, pubURL);
    const primaryEntryReadingOrderURL =
      primaryEntryPath !== null
        ? encodeURLPath(primaryEntryPath)
        : /^(?:about:|blob:)/i.test(primaryEntryURL)
          ? primaryEntryURL
          : null;
    if (
      !manifestObj["readingOrder"] &&
      doc &&
      primaryEntryReadingOrderURL !== null
    ) {
      manifestObj["readingOrder"] = [primaryEntryReadingOrderURL];

      // Find TOC in the primary entry (X)HTML
      for (const anchorElem of Toc.findTocAnchorElements(doc)) {
        const href = anchorElem.getAttribute("href");
        if (/^(https?:)?\/\//.test(href)) {
          // Avoid link to external resources
          continue;
        }
        if (/\.(jpe?g|png|gif|pdf|svg|mml)([#?]|$)/.test(href)) {
          // Avoid link to non-HTML resources
          continue;
        }
        const hrefNoFragment = Base.stripFragment(
          Base.resolveURL(href, pubURL),
        );
        const path = getPathFromURL(hrefNoFragment, pubURL);
        const url = path !== null ? encodeURLPath(path) : hrefNoFragment;
        if (!manifestObj["readingOrder"].includes(url)) {
          manifestObj["readingOrder"].push(url);
        }
      }
    }

    const params: OPFItemParam[] = [];
    let itemCount = 0;
    let tocFound = -1;
    [manifestObj["readingOrder"], manifestObj["resources"]].forEach(
      (readingOrderOrResources) => {
        if (readingOrderOrResources instanceof Array) {
          readingOrderOrResources.forEach((itemObj) => {
            const isInReadingOrder =
              readingOrderOrResources === manifestObj["readingOrder"];
            const url =
              typeof itemObj === "string"
                ? itemObj
                : itemObj.url || itemObj.href;
            const encodingFormat =
              typeof itemObj === "string"
                ? ""
                : itemObj.encodingFormat ||
                  (itemObj.href && itemObj.type) ||
                  "";
            if (
              isInReadingOrder ||
              encodingFormat === "text/html" ||
              encodingFormat === "application/xhtml+xml" ||
              (!encodingFormat &&
                itemObj.rel !== "stylesheet" &&
                /(^|\/)([^/]+\.(x?html|htm|xht)|[^/.]*)([#?]|$)/.test(url))
            ) {
              const baseUrl = manifestUrl
                ? manifestUrl.replace(/\/[^/]+$/, "/")
                : pubURL;
              const param = {
                url: Base.resolveURL(Base.convertSpecialURL(url), baseUrl),
                index: itemCount++,
                startPage: null,
                skipPagesBefore: null,
              };
              if (itemObj.rel === "contents" && tocFound === -1) {
                tocFound = param.index;
              }
              params.push(param);
            }
          });
        }
      },
    );
    const opf = await OPFDoc.fromChapters(store, pubURL, params);
    opf.pageProgression = pageProgression;
    opf.metadata = metadata;
    if (tocFound !== -1) {
      opf.toc = opf.items[tocFound];
    }

    if (!opf.toc) {
      opf.toc = manifestUrl
        ? (opf.items[0] ?? null)
        : opf.itemMapByPath[primaryEntryPath];
    }

    // remove items not in readingOrder (Issue #1257)
    const readingOrderCount = manifestObj["readingOrder"]?.length;
    if (readingOrderCount && readingOrderCount < opf.items.length) {
      opf.items.splice(readingOrderCount);
    }

    return opf;
  }

  /**
   * @return cfi
   */
  async getCFI(
    spineIndex: number,
    offsetInItem: number,
  ): Promise<string | null> {
    const item = this.spine[spineIndex];
    const xmldoc = await this.store.load(item.src);
    const node = xmldoc.getNodeByOffset(offsetInItem);
    let cfi: string | null = null;
    if (node) {
      const startOffset = xmldoc.getNodeOffset(node, 0, false);
      const offsetInNode = offsetInItem - startOffset;
      const fragment = new CFI.Fragment();
      fragment.prependPathFromNode(node, offsetInNode, false, null);
      if (item.itemRefElement) {
        fragment.prependPathFromNode(item.itemRefElement, 0, false, null);
      }
      cfi = fragment.toString();
    }
    return cfi;
  }

  async resolveFragment(fragstr: string | null): Promise<Position | null> {
    try {
      if (!fragstr) {
        return null;
      }
      let fragment = new CFI.Fragment();
      fragment.fromString(fragstr);
      let item: OPFItem;
      if (this.opfXML) {
        const opfNav = fragment.navigate(this.opfXML.document);
        if (opfNav.node.nodeType != 1 || opfNav.after || !opfNav.ref) {
          return null;
        }
        const elem = opfNav.node as Element;
        const idref = elem.getAttribute("idref");
        if (elem.localName != "itemref" || !idref || !this.itemMap[idref]) {
          return null;
        }
        item = this.itemMap[idref];
        fragment = opfNav.ref;
      } else {
        item = this.spine[0];
      }
      const xmldoc = await this.store.load(item.src);
      const nodeNav = fragment.navigate(xmldoc.document);
      const offset = xmldoc.getNodeOffset(
        nodeNav.node,
        nodeNav.offset,
        nodeNav.after,
      );
      return {
        spineIndex: item.spineIndex,
        offsetInItem: offset,
        pageIndex: -1,
      };
    } catch (err) {
      Logging.logger.warn(err, "Cannot resolve fragment:", fragstr);
      return null;
    }
  }

  async resolveEPage(epage: number): Promise<Position | null> {
    try {
      if (epage <= 0) {
        return { spineIndex: 0, offsetInItem: 0, pageIndex: -1 };
      }
      if (this.epageIsRenderedPage) {
        let spineIndex = this.spine.findIndex((item) => {
          return (
            (item.epage == 0 && item.epageCount == 0) ||
            (item.epage <= epage && item.epage + item.epageCount > epage)
          );
        });
        if (spineIndex == -1) {
          spineIndex = this.spine.length - 1;
        }
        let item = this.spine[spineIndex];
        if (!item || item.epageCount == 0) {
          item = this.spine[--spineIndex];
        }
        const pageIndex = Math.floor(epage - item.epage);
        return { spineIndex, offsetInItem: -1, pageIndex: pageIndex };
      }
      let spineIndex = Base.binarySearch(this.spine.length, (index) => {
        const item = this.spine[index];
        return item.epage + item.epageCount > epage;
      });
      if (spineIndex == this.spine.length) {
        spineIndex--;
      }
      const item = this.spine[spineIndex];
      const xmldoc = await this.store.load(item.src);
      epage -= item.epage;
      if (epage > item.epageCount) {
        epage = item.epageCount;
      }
      let offset = 0;
      if (epage > 0) {
        const totalOffset = xmldoc.getTotalOffset();
        offset = Math.round((totalOffset * epage) / item.epageCount);
        if (offset == totalOffset) {
          offset--;
        }
      }
      return { spineIndex, offsetInItem: offset, pageIndex: -1 };
    } catch (err) {
      Logging.logger.warn(err, "Cannot resolve epage:", epage);
      return null;
    }
  }

  async getEPageFromPosition(position: Position): Promise<number> {
    const item = this.spine[position.spineIndex];
    if (this.epageIsRenderedPage) {
      return item.epage + position.pageIndex;
    }
    if (position.offsetInItem <= 0) {
      return item.epage;
    }
    const xmldoc = await this.store.load(item.src);
    const totalOffset = xmldoc.getTotalOffset();
    const offset = Math.min(totalOffset, position.offsetInItem);
    return item.epage + (offset * item.epageCount) / totalOffset;
  }
}

export type PageAndPosition = {
  page: Vtree.Page;
  position: Position;
};

export const makePageAndPosition = (
  page: Vtree.Page,
  pageIndex: number,
): PageAndPosition => ({
  page,
  position: {
    spineIndex: page.spineIndex,
    pageIndex,
    offsetInItem: page.offset,
  },
});

export type OPFViewItem = {
  item: OPFItem;
  xmldoc: XmlDoc.XMLDocHolder;
  instance: OPS.StyleInstance;
  layoutPositions: Array<Vtree.LayoutPosition | null>;
  pages: Vtree.Page[];
  complete: boolean;
  pageCounterStarts: CssCascade.CounterValues[];
};

type DeferredReferencePage = {
  viewItem: OPFViewItem;
  page: Vtree.Page;
  pageIndex: number;
  nextLayoutPosition: Vtree.LayoutPosition | null;
};

export class OPFView implements Vgen.CustomRendererFactory {
  spineItems: (OPFViewItem | null)[] = [];
  /**
   * The loading of the view item of each spine item, shared by everyone who
   * asks for it while it is in progress. Reset to null together with
   * `spineItems` to load the spine item again.
   */
  spineItemLoading: (Promise<OPFViewItem> | null)[] = [];
  pref: Exprs.Preferences;
  clientLayout: Vgen.DefaultClientLayout;
  counterStore: Counters.CounterStore;
  cmykStore: CmykStore.CmykStore;
  tocAutohide: boolean = false;
  tocVisible: boolean = false;
  tocView?: Toc.TOCView;
  private deferredReferencePages: DeferredReferencePage[] = [];
  private resolvingDeferredReferences: boolean = false;
  private processedDeferredReferencePages: Map<
    OPFViewItem,
    Set<number>
  > | null = null;
  private deferredFollowingSpineRelayoutStart: number | null = null;
  private deferredPageReplacements = new Map<number, Vtree.Page[]>();
  private relayoutingFollowingSpines: boolean = false;
  private relayoutingFollowingSpineStart: number | null = null;
  private renderingAllPages: boolean = false;
  private paginationProgress = {
    totalOffsetsBySpine: [] as number[],
    renderedOffsetsBySpine: [] as number[],
    totalOffsetsReady: false,
    lastReportedPages: 0,
    lastReportedFraction: 0,
    lastReportedSpineIndex: -1,
    lastReportedHref: "",
  };

  constructor(
    public readonly opf: OPFDoc,
    public readonly viewport: Vgen.Viewport,
    public readonly fontMapper: Font.Mapper,
    pref: Exprs.Preferences,
    public readonly pageSheetSizeReporter: (
      p1: { width: number; height: number },
      p2: { [key: string]: { width: number; height: number } },
      p3: number,
      p4: number,
    ) => any,
    cmykReserveMap?: CmykStore.CmykReserveMapEntry[],
    public readonly pageSheetSizeTruncator: (
      pageCount: number,
    ) => void = () => {},
  ) {
    this.pref = Exprs.clonePreferences(pref);
    this.clientLayout = new Vgen.DefaultClientLayout(viewport);
    this.counterStore = new Counters.CounterStore(opf.documentURLTransformer);
    this.cmykStore = new CmykStore.CmykStore();
    if (cmykReserveMap?.length) {
      this.cmykStore.registerCmykReserveMap(cmykReserveMap);
    }
  }

  private getPage(position: Position): Vtree.Page | null {
    const viewItem = this.spineItems[position.spineIndex];
    return viewItem ? viewItem.pages[position.pageIndex] : null;
  }

  /**
   * Wait until all previous spine items are loaded before accessing the target
   * spine item. This prevents corrupting the page counter state when navigating
   * to a later spine item while rendering is in progress.
   * (Fix for issue #1616)
   * @param spineIndex The target spine index to navigate to
   * @param sync If true, skip waiting (synchronous mode)
   */
  private async waitForPreviousSpines(
    spineIndex: number,
    sync: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (sync || spineIndex === 0) {
      return true;
    }
    for (;;) {
      // Check if any previous spine item is not yet complete
      let allPreviousComplete = true;
      for (let i = 0; i < spineIndex; i++) {
        const prevItem = this.spineItems[i];
        if (!prevItem || !prevItem.complete) {
          allPreviousComplete = false;
          break;
        }
      }
      if (allPreviousComplete) {
        return true;
      }
      await this.waitForRenderChange(signal);
    }
  }

  /**
   * Waits until the rendering state may have changed: a renderer released the
   * lock or finished a rebuild. Pages that appear while a renderer holds the
   * lock are deliberately not announced, so that a navigation does not take a
   * page before the renderer has finished its follow-up work on it. It also
   * wakes up after 100 ms, in case a change was not announced.
   */
  private waitForRenderChange(signal?: AbortSignal): Promise<void> {
    return this.renderLock.changed(100, signal);
  }

  private notifyRenderChange(): void {
    this.renderLock?.notify();
  }

  getCurrentPageProgression(
    position: Position,
  ): Constants.PageProgression | null {
    if (this.opf.pageProgression) {
      return this.opf.pageProgression;
    } else {
      const viewItem = this.spineItems[position ? position.spineIndex : 0];
      return viewItem ? viewItem.instance.pageProgression : null;
    }
  }

  private finishPageContainer(
    viewItem: OPFViewItem,
    page: Vtree.Page,
    pageIndex: number,
  ) {
    page.container.style.display = "none";
    page.container.style.visibility = "visible";
    page.container.style.position = "";
    page.container.style.top = "";
    page.container.style.left = "";
    page.container.setAttribute(
      "data-vivliostyle-page-side",
      page.side as string,
    );
    const oldPage = viewItem.pages[pageIndex];
    const deferredOldPage = this.takeDeferredPageReplacement(
      viewItem.item.spineIndex,
      page,
    );
    page.isFirstPage = viewItem.item.spineIndex == 0 && pageIndex == 0;
    viewItem.pages[pageIndex] = page;

    if (this.opf.epageIsRenderedPage) {
      if (pageIndex == 0 && viewItem.item.spineIndex > 0) {
        const prevItem = this.opf.spine[viewItem.item.spineIndex - 1];
        viewItem.item.epage = prevItem.epage + prevItem.epageCount;
      }
      viewItem.item.epageCount = viewItem.pages.length;
      this.opf.epageCount = this.opf.spine.reduce(
        (count, item) => count + item.epageCount,
        0,
      );

      this.opf.epageCountCallback?.(this.opf.epageCount);
    }

    if (oldPage) {
      viewItem.instance.viewport.contentContainer.replaceChild(
        page.container,
        oldPage.container,
      );
    } else {
      // Find insert position in contentContainer.
      let insertPos: Element | null = null;
      if (pageIndex > 0) {
        insertPos = viewItem.pages[pageIndex - 1].container.nextElementSibling;
      } else {
        for (
          let i = viewItem.item.spineIndex + 1;
          i < this.spineItems.length;
          i++
        ) {
          const item = this.spineItems[i];
          if (item && item.pages[0]) {
            insertPos = item.pages[0].container;
            break;
          }
        }
      }
      viewItem.instance.viewport.contentContainer.insertBefore(
        page.container,
        insertPos,
      );
    }
    if (oldPage) {
      this.dispatchPageReplacement(oldPage, page);
    }
    if (deferredOldPage && deferredOldPage !== oldPage) {
      this.dispatchPageReplacement(deferredOldPage, page);
    }
    this.pageSheetSizeReporter(
      {
        width: viewItem.instance.pageSheetWidth,
        height: viewItem.instance.pageSheetHeight,
      },
      viewItem.instance.pageSheetSize,
      viewItem.item.spineIndex,
      viewItem.instance.pageNumberOffset + pageIndex,
    );
  }

  private getRenderedPageCount(): number {
    let count = 0;
    for (const item of this.spineItems) {
      if (item) {
        count += item.pages.length;
      }
    }
    return count;
  }

  private getRenderedPageSizeCount(): number {
    let count = 0;
    for (const item of this.spineItems) {
      if (item) {
        count = Math.max(
          count,
          item.instance.pageNumberOffset + item.pages.length,
        );
      }
    }
    return count;
  }

  /**
   * Mark a spine item as complete if all layout positions have corresponding
   * rendered pages (Issue #1498).  When the item becomes complete, clean up
   * inherited CSS properties that were propagated to the layout box during
   * page float rendering so they don't leak into the next spine item or
   * remain in the DOM after layout (Issue #1752).
   */
  private markSpineItemCompleteIfReady(viewItem: OPFViewItem): void {
    viewItem.complete =
      viewItem.layoutPositions.length === viewItem.pages.length;
    if (viewItem.complete) {
      viewItem.instance.viewport.layoutBox.removeAttribute("style");
      this.flushDeferredPageReplacements(viewItem);
    }
  }

  private getTotalOffsetForViewItem(viewItem: OPFViewItem): number {
    const spineIndex = viewItem.item.spineIndex;
    let totalOffset = this.paginationProgress.totalOffsetsBySpine[spineIndex];
    if (totalOffset == null) {
      totalOffset = viewItem.xmldoc.getTotalOffset();
      this.paginationProgress.totalOffsetsBySpine[spineIndex] = totalOffset;
    }
    return totalOffset;
  }

  /**
   * Load all spine items (fetch and parse only, without layout) and record
   * their total offsets, so that the pagination progress fraction is
   * computed against the whole publication.
   */
  private async collectTotalOffsets(): Promise<boolean> {
    if (this.paginationProgress.totalOffsetsReady) {
      return true;
    }
    const totals = this.paginationProgress.totalOffsetsBySpine;
    for (let spineIndex = 0; spineIndex < this.opf.spine.length; spineIndex++) {
      if (totals[spineIndex] != null) {
        continue;
      }
      const item = this.opf.spine[spineIndex];
      const xmldoc = await this.opf.store.load(item.src);
      if (xmldoc) {
        totals[spineIndex] = xmldoc.getTotalOffset();
      }
    }
    this.paginationProgress.totalOffsetsReady = true;
    return true;
  }

  private getTotalOffsetAll(): number {
    let total = 0;
    for (const totalOffset of this.paginationProgress.totalOffsetsBySpine) {
      if (totalOffset) {
        total += totalOffset;
      }
    }
    return total;
  }

  private getRenderedOffsetAll(): number {
    let total = 0;
    const totals = this.paginationProgress.totalOffsetsBySpine;
    const rendered = this.paginationProgress.renderedOffsetsBySpine;
    for (let i = 0; i < totals.length; i++) {
      const totalOffset = totals[i];
      if (!totalOffset) {
        continue;
      }
      const renderedOffset = rendered[i] ?? 0;
      total += Math.min(totalOffset, renderedOffset);
    }
    return total;
  }

  private reportPaginationProgress(
    viewItem: OPFViewItem,
    nextLayoutPosition: Vtree.LayoutPosition | null,
  ) {
    const hooks: Plugin.PaginationProgressHook[] = Plugin.getHooksForName(
      Plugin.HOOKS.PAGINATION_PROGRESS,
    );
    if (!hooks.length) {
      return;
    }
    const spineIndex = viewItem.item.spineIndex;
    const totalOffset = this.getTotalOffsetForViewItem(viewItem);
    let renderedOffset = totalOffset;
    if (nextLayoutPosition) {
      renderedOffset = viewItem.instance.getPosition(nextLayoutPosition, true);
    }
    if (renderedOffset < 0) {
      renderedOffset = 0;
    }
    if (renderedOffset > totalOffset) {
      renderedOffset = totalOffset;
    }
    const prevOffset =
      this.paginationProgress.renderedOffsetsBySpine[spineIndex];
    if (prevOffset != null && renderedOffset < prevOffset) {
      renderedOffset = prevOffset;
    }
    this.paginationProgress.renderedOffsetsBySpine[spineIndex] = renderedOffset;

    const pages = this.getRenderedPageCount();
    const totalOffsetAll = this.getTotalOffsetAll();
    const renderedOffsetAll = this.getRenderedOffsetAll();
    let fraction = totalOffsetAll > 0 ? renderedOffsetAll / totalOffsetAll : 0;
    if (fraction < this.paginationProgress.lastReportedFraction) {
      fraction = this.paginationProgress.lastReportedFraction;
    } else {
      this.paginationProgress.lastReportedFraction = fraction;
    }
    if (pages > this.paginationProgress.lastReportedPages) {
      this.paginationProgress.lastReportedPages = pages;
    }

    let href = viewItem.item.src;
    if (spineIndex >= (this.paginationProgress.lastReportedSpineIndex ?? -1)) {
      this.paginationProgress.lastReportedSpineIndex = spineIndex;
      this.paginationProgress.lastReportedHref = href;
    } else {
      href = this.paginationProgress.lastReportedHref ?? href;
    }

    const payload = {
      fraction,
      pages: this.paginationProgress.lastReportedPages,
      href,
    };
    for (const hook of hooks) {
      try {
        hook(payload);
      } catch (err) {
        Logging.logger.warn(err as Error);
      }
    }
  }

  private isInCounterResolveScope(): boolean {
    return this.counterStore.currentPageCountersStack.length > 0;
  }

  private hasNonEmptyPageType(page: Vtree.Page | null | undefined): boolean {
    return !!page?.pageType && page.pageType !== "";
  }

  private hasPageTypeBoundaryBetween(
    previousPage: Vtree.Page | null,
    currentPage: Vtree.Page | null,
  ): boolean {
    return (
      previousPage?.pageType != null &&
      currentPage?.pageType != null &&
      previousPage.pageType !== currentPage.pageType
    );
  }

  private resolvePageTypeForRenderSlot(
    viewItem: OPFViewItem,
    page: Vtree.Page,
    pageIndexToRender: number,
    oldPage: Vtree.Page | null,
    prevPage: Vtree.Page | null,
    nextExistingPage: Vtree.Page | null,
    inCounterResolveScopeAtStart: boolean,
  ): void {
    let shouldKeepOldPageType = false;
    if (oldPage) {
      const hasBoundaryBetweenPrevAndOld = this.hasPageTypeBoundaryBetween(
        prevPage,
        oldPage,
      );
      const nextPageContinuesOldPageType =
        nextExistingPage?.pageType === oldPage.pageType;
      const isOldPageOffsetStale = oldPage.offset !== page.offset;

      // If the old page exists, keep the pageType (named page).
      // This is necessary for named page with target-counter() to work.
      // (fix for issue #1136)
      const shouldKeepOldPageTypeInCounterResolveScope =
        // In target-counter resolution rerender, preserve the existing
        // pageType only when the old page is still layout-consistent.
        inCounterResolveScopeAtStart &&
        !isOldPageOffsetStale &&
        pageIndexToRender > 0;
      shouldKeepOldPageType =
        oldPage.pageType != null &&
        (shouldKeepOldPageTypeInCounterResolveScope ||
          pageIndexToRender === 0 ||
          oldPage.pageType === prevPage?.pageType);
      page.pageType = shouldKeepOldPageType ? oldPage.pageType : null;

      if (inCounterResolveScopeAtStart) {
        // Re-resolve the page-start type during target-counter rerender so a
        // stale named page is not reused when the new start is actually default.
        const pageStartPageType =
          viewItem.instance.getPageStartPageTypeOverride(page.position);
        if (pageStartPageType === "") {
          page.pageType = "";
        } else if (pageStartPageType) {
          page.pageType = pageStartPageType;
        }
      }

      if (!inCounterResolveScopeAtStart && !shouldKeepOldPageType) {
        const shouldUsePrevPageTypeToFixEarlyBoundary =
          pageIndexToRender > 1 &&
          hasBoundaryBetweenPrevAndOld &&
          nextPageContinuesOldPageType;
        // For a suspected one-page-early boundary, start from previous pageType
        // so the continuation page remains in the expected named-page run.
        const currentPageType = shouldUsePrevPageTypeToFixEarlyBoundary
          ? prevPage.pageType
          : null;
        viewItem.instance.styler.cascade.currentPageType = currentPageType;
        viewItem.instance.pageManager.pageCascadeInstance.currentPageType =
          currentPageType;
      }
    }

    const shouldSeedFromPrevPageType =
      !inCounterResolveScopeAtStart &&
      this.hasNonEmptyPageType(prevPage) &&
      this.hasNonEmptyPageType(nextExistingPage) &&
      prevPage.pageType !== nextExistingPage.pageType &&
      (!oldPage || oldPage.pageType == null);
    if (shouldSeedFromPrevPageType) {
      // If this slot has no reliable pageType yet, tentatively continue from
      // the previous named page to avoid early boundary drift during rerender.
      page.pageType = prevPage.pageType;
    }
  }

  private evaluateNextPageRelayout(
    oldPage: Vtree.Page | null,
    nextPage: Vtree.Page | null,
    positionChanged: boolean,
    offsetChanged: boolean,
    inCounterResolveScope: boolean,
  ): { needsRelayout: boolean; shouldCascade: boolean } {
    if (!oldPage || (!!nextPage && !positionChanged)) {
      return { needsRelayout: false, shouldCascade: false };
    }

    const shouldCascadeInCounterResolveScope =
      !!nextPage &&
      (oldPage.pageType === nextPage.pageType || !nextPage.pageType);
    const shouldResetNextPageTypeFromPositionChange =
      !!nextPage &&
      offsetChanged &&
      (!inCounterResolveScope || shouldCascadeInCounterResolveScope) &&
      (nextPage.pageType == null ||
        oldPage.pageType == null ||
        oldPage.pageType !== nextPage.pageType);
    if (shouldResetNextPageTypeFromPositionChange) {
      // If the previous page break position changed, the existing next
      // page may now start in a different named-page context.
      // Reset pageType so layoutNextPage() recalculates it.
      // (fix for issue #1497)
      nextPage.pageType = null;
    }

    // When inside a target-counter/target-text resolution scope
    // (pushPageCounters/popPageCounters), do not cascade to render
    // pages that have not been rendered yet. Creating new pages
    // inside the push/pop scope causes currentPageCounters to
    // advance, but popPageCounters then restores stale values,
    // leading to wrong page counter numbers on subsequently
    // rendered pages.
    const shouldCascadeToNextPage = !!nextPage || !inCounterResolveScope;
    return {
      needsRelayout: true,
      shouldCascade: shouldCascadeToNextPage,
    };
  }

  private preparePageCountersForRender(
    viewItem: OPFViewItem,
    pageIndexToRender: number,
  ): Vtree.Page | null {
    const oldPage = viewItem.pages[pageIndexToRender];
    // Restore page counter starts when re-rendering a page so target-counter()
    // and page-based counters stay stable across relayouts.
    const storedCounters = viewItem.pageCounterStarts[pageIndexToRender];
    if (oldPage && storedCounters) {
      this.counterStore.currentPageCounters =
        cloneCounterValues(storedCounters);
    }
    const startCounters = cloneCounterValues(
      this.counterStore.currentPageCounters,
    );
    if (!storedCounters || !oldPage) {
      viewItem.pageCounterStarts[pageIndexToRender] = startCounters;
    }
    return oldPage;
  }

  private async maybeRelayoutFollowingPage(
    viewItem: OPFViewItem,
    nextLayoutPosition: Vtree.LayoutPosition | null,
    oldPage: Vtree.Page | null,
    renderedPage: Vtree.Page,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!nextLayoutPosition) {
      return;
    }

    const previousLayoutPosition =
      viewItem.layoutPositions[nextLayoutPosition.page];
    viewItem.layoutPositions[nextLayoutPosition.page] = nextLayoutPosition;
    const nextPage = viewItem.pages[nextLayoutPosition.page];
    const offsetChanged = !!oldPage && renderedPage.offset !== oldPage.offset;
    const hasActivePageFloatState =
      viewItem.instance.hasActiveRootPageFloatLayoutContext();
    // Even if the source layout position is unchanged, active root page-float
    // state can still change following pages through deferred continuations.
    const positionChanged =
      !previousLayoutPosition ||
      !nextLayoutPosition.isSamePosition(previousLayoutPosition) ||
      nextLayoutPosition.highestSeenOffset !==
        previousLayoutPosition.highestSeenOffset ||
      offsetChanged ||
      hasActivePageFloatState;
    const inCounterResolveScope = this.isInCounterResolveScope();
    const relayoutDecision = this.evaluateNextPageRelayout(
      oldPage,
      nextPage,
      positionChanged,
      offsetChanged,
      inCounterResolveScope,
    );
    if (!relayoutDecision.needsRelayout) {
      return;
    }

    viewItem.complete = false;
    if (!relayoutDecision.shouldCascade) {
      return;
    }
    await this.renderSinglePage(viewItem, nextLayoutPosition, signal);
  }

  private async resolveUnresolvedReferencesForPage(
    viewItem: OPFViewItem,
    page: Vtree.Page,
    pageIndex: number,
    nextLayoutPosition: Vtree.LayoutPosition | null,
    signal?: AbortSignal,
  ): Promise<Vtree.Page> {
    // When inside a target-counter/target-text resolution scope
    // (pushPageCounters/popPageCounters), skip processing unresolved
    // references on cascaded pages to prevent infinite re-layout loops.
    // References that remain unresolved will be resolved when their
    // target pages are rendered in the normal (non-cascade) flow.
    // (fix for issue #1686)
    const inCounterResolveScope = this.isInCounterResolveScope();
    if (inCounterResolveScope) {
      // A cascaded page can invalidate references even when it is not the
      // page that started the current counter-resolution scope. Remember the
      // actual page at the point where #1686 defers it, so the outermost pop
      // can revisit it later.
      this.deferReferencesForPage(
        viewItem,
        page,
        pageIndex,
        nextLayoutPosition,
      );
    }
    const unresolvedRefs = inCounterResolveScope
      ? []
      : this.counterStore.getUnresolvedRefsToPage(page);
    let currentPage = page;

    for (const refs of unresolvedRefs) {
      refs.refs = refs.refs.filter(
        (ref) => !ref.isResolved() && this.counterStore.isReferenceTracked(ref),
      );
      if (refs.refs.length === 0) {
        continue;
      }
      const targetViewItem = await this.getPageViewItem(refs.spineIndex);
      if (!targetViewItem) {
        continue;
      }
      // Save page type states and restore them after re-rendering page.
      // This is necessary for named page with target-counter() to work.
      // (fix for issues #1272 and #1497)
      const stylerCascade = targetViewItem.instance.styler.cascade;
      const pageCascade =
        targetViewItem.instance.pageManager.pageCascadeInstance;
      const savedStylerPageTypeState = {
        currentPageType: stylerCascade.currentPageType,
        previousPageType: stylerCascade.previousPageType,
      };
      const savedPageCascadePageTypeState = {
        currentPageType: pageCascade.currentPageType,
        previousPageType: pageCascade.previousPageType,
      };
      const savedPageGroupPageCounts = clonePageGroupPageCounts(
        targetViewItem.instance.pageGroupPageCounts,
      );
      const savedCurrentPageGroupDocument =
        targetViewItem.instance.currentPageGroupDocument;

      // Save the scopes and restore them after re-rendering page.
      // This is necessary for :blank page selector to work.
      // (fix for issues #1131 and #1513)
      const scopes = targetViewItem.instance.scopes;
      targetViewItem.instance.scopes = new Map();

      // Isolate root page-float layout context only when re-rendering an
      // already rendered target page. For first-time rendering of the
      // target page, keep the normal context so deferred page-floats can
      // continue to subsequent pages.
      // (fix for issue #1094 and regression in
      // target-counter-and-page-floats.html)
      const hasRenderedFollowingPage =
        refs.pageIndex < targetViewItem.pages.length - 1;
      const hasRenderedTargetPage = !!targetViewItem.pages[refs.pageIndex];
      const shouldIsolateRootPageFloatLayoutContext =
        hasRenderedTargetPage && hasRenderedFollowingPage;
      const previousPageFloatLayoutContext =
        shouldIsolateRootPageFloatLayoutContext && refs.pageIndex > 0
          ? targetViewItem.pages[refs.pageIndex - 1]?.pageFloatLayoutContext
          : null;
      const originalRootPageFloatLayoutContext =
        shouldIsolateRootPageFloatLayoutContext
          ? targetViewItem.instance.beginIsolatedRootPageFloatLayoutContext(
              previousPageFloatLayoutContext,
            )
          : null;

      this.counterStore.pushPageCounters(refs.pageCounters);
      this.counterStore.pushReferencesToSolve(refs.refs);
      const pos = targetViewItem.layoutPositions[refs.pageIndex];
      if (hasRenderedTargetPage) {
        // Same-page rerenders should recompute :nth(... of <page-type>)
        // from the page-group state of earlier pages only.
        targetViewItem.instance.preparePageGroupPageIndicesForRerender(
          targetViewItem.layoutPositions,
          refs.pageIndex,
        );
      }

      const result = await this.renderSinglePage(targetViewItem, pos, signal);
      if (shouldIsolateRootPageFloatLayoutContext) {
        targetViewItem.instance.endIsolatedRootPageFloatLayoutContext(
          originalRootPageFloatLayoutContext,
        );
      }
      const beforeRestoreStylerCurrentPageType = stylerCascade.currentPageType;
      stylerCascade.currentPageType = savedStylerPageTypeState.currentPageType;
      stylerCascade.previousPageType =
        savedStylerPageTypeState.previousPageType;

      pageCascade.currentPageType =
        savedPageCascadePageTypeState.currentPageType;
      pageCascade.previousPageType =
        savedPageCascadePageTypeState.previousPageType;
      targetViewItem.instance.pageGroupPageCounts = savedPageGroupPageCounts;
      targetViewItem.instance.currentPageGroupDocument =
        savedCurrentPageGroupDocument;
      targetViewItem.instance.scopes = scopes;
      // Save the counter state BEFORE popping. After renderSinglePage,
      // currentPageCounters reflects the correct end state for the
      // target page within the pushed scope. This is the correct
      // starting state for any pending page created by cascade blocking.
      // After popPageCounters, this state is lost (restored to the
      // source spine's counters), so save it now.
      const counterStateAfterTargetRender = cloneCounterValues(
        this.counterStore.currentPageCounters,
      );
      this.counterStore.popPageCounters();
      this.counterStore.popReferencesToSolve();
      if (
        result.pageAndPosition.position.spineIndex === currentPage.spineIndex &&
        result.pageAndPosition.position.pageIndex === pageIndex
      ) {
        currentPage = result.pageAndPosition.page;
      }
      // Keep the current pageType aligned when recursive rerender of
      // target-counter() shifts this page's named-page context.
      // Guard with previous value checks to avoid leaking unrelated
      // pageType updates from other rerender targets.
      const shouldSyncStylerCurrentPageType =
        !!currentPage.pageType &&
        currentPage.pageType !== savedStylerPageTypeState.currentPageType &&
        beforeRestoreStylerCurrentPageType !==
          result.pageAndPosition.page.pageType;
      if (shouldSyncStylerCurrentPageType) {
        stylerCascade.currentPageType = currentPage.pageType;
      }
      // Issue #1498: target-counter() resolution can leave one pending
      // layout slot (layoutPositions has next page) without an actual
      // rendered page in pages[]. Materialize that pending page here so
      // later navigation/render loops do not stop one page early.
      const isCrossSpine = targetViewItem !== viewItem;
      const firstPendingPageIndex = targetViewItem.pages.length;
      const pendingLayoutPosition =
        targetViewItem.layoutPositions[firstPendingPageIndex];
      // Recompute root page-float layout context state after rerender and
      // context restoration to avoid using stale pre-rerender state.
      const hasActiveRootPageFloatLayoutContextAfterRerender =
        targetViewItem.instance.hasActiveRootPageFloatLayoutContext();
      if (
        pendingLayoutPosition &&
        !hasActiveRootPageFloatLayoutContextAfterRerender
      ) {
        // For cross-spine cases, save/restore counter state around the
        // pending page render and use the counter state saved before
        // popPageCounters, because the global state after pop reflects
        // the source spine, not the target spine.
        const savedCountersBeforePending = isCrossSpine
          ? cloneCounterValues(this.counterStore.currentPageCounters)
          : null;
        if (isCrossSpine) {
          this.counterStore.currentPageCounters = counterStateAfterTargetRender;
        }
        const pageCountBeforePending = firstPendingPageIndex;
        await this.renderSinglePage(
          targetViewItem,
          pendingLayoutPosition,
          signal,
        );
        if (isCrossSpine) {
          this.markSpineItemCompleteIfReady(targetViewItem);
        }
        // After the pending page expanded the target spine,
        // pageCountersById snapshots for elements in later spines
        // are stale (page counter is off by the added pages).
        // Adjust those snapshots, shift the saved source-spine
        // counter state so subsequent pages start from the
        // corrected offset, and patch already-rendered
        // target-counter DOM nodes in the expanded spine's pages.
        const pageDelta = targetViewItem.pages.length - pageCountBeforePending;
        if (isCrossSpine && pageDelta > 0) {
          this.counterStore.adjustPageCountersOfLaterSpines(
            targetViewItem.item.spineIndex,
            pageDelta,
          );
          this.counterStore.updateTargetCounterNodesInPages(
            targetViewItem.pages,
          );
          this.updateEPageRangesAfterPageCountChange(
            targetViewItem,
            targetViewItem.pages.length,
          );
          // Adjust pageCounterStarts and page-counter DOM nodes
          // for all already-rendered later-spine viewItems so
          // their counter(page) margins show the corrected value
          // and future re-renders start from the right offset.
          const expandedIdx = targetViewItem.item.spineIndex;
          for (let si = expandedIdx + 1; si < this.spineItems.length; si++) {
            const laterItem = this.spineItems[si];
            if (!laterItem) continue;
            for (const pcs of laterItem.pageCounterStarts) {
              if (pcs?.["page"]) {
                pcs["page"] = pcs["page"].map((v) => v + pageDelta);
              }
            }
            this.counterStore.updatePageCounterNodesInPages(
              laterItem.pages,
              laterItem.pageCounterStarts,
            );
          }
          // Shift the saved source-spine counter state so that
          // when it is restored below, subsequent pages of the
          // source spine continue with the corrected page offset.
          if (savedCountersBeforePending) {
            const srcPage = savedCountersBeforePending["page"];
            if (srcPage) {
              savedCountersBeforePending["page"] = srcPage.map(
                (v) => v + pageDelta,
              );
            }
          }
        }
        if (savedCountersBeforePending) {
          this.counterStore.currentPageCounters = savedCountersBeforePending;
        }
      } else if (isCrossSpine) {
        // The target spine's re-render (or cascade inside the resolve
        // scope) may have set complete=false even when no pending page
        // was created. Re-check completeness so navigation can advance
        // past this spine. Only for cross-spine cases.
        this.markSpineItemCompleteIfReady(targetViewItem);
      }
      await this.resolveDeferredReferencesAfterCounterScope(
        targetViewItem,
        result.pageAndPosition.page,
        result.pageAndPosition.position.pageIndex,
        result.nextLayoutPosition,
        signal,
      );
    }

    if (!currentPage.container.parentElement) {
      // page is replaced
      currentPage = viewItem.pages[pageIndex];
    }
    currentPage.isLastPage =
      !nextLayoutPosition &&
      viewItem.item.spineIndex === this.opf.spine.length - 1;
    if (currentPage.isLastPage) {
      this.counterStore.finishLastPage(this.viewport);
    }
    currentPage.container.setAttribute(
      "data-vivliostyle-page-index",
      pageIndex,
    );
    currentPage.container.setAttribute(
      "data-vivliostyle-spine-index",
      currentPage.spineIndex,
    );
    return currentPage;
  }

  private async resolveDeferredReferencesAfterCounterScope(
    viewItem: OPFViewItem,
    page: Vtree.Page,
    pageIndex: number,
    nextLayoutPosition: Vtree.LayoutPosition | null,
    signal?: AbortSignal,
  ): Promise<Vtree.Page> {
    // A target page may be rerendered several scopes deep. Processing its
    // newly invalidated references immediately after the innermost pop still
    // hits the #1686 recursion guard because an outer counter scope remains.
    // Keep the page until the outermost scope is restored, then drain all
    // deferred pages in order.
    this.deferReferencesForPage(viewItem, page, pageIndex, nextLayoutPosition);
    const deferredReferencePages = this.deferredReferencePages;

    if (
      this.isInCounterResolveScope() ||
      this.resolvingDeferredReferences ||
      deferredReferencePages.length === 0
    ) {
      return page;
    }

    this.resolvingDeferredReferences = true;
    this.processedDeferredReferencePages = new Map();
    try {
      for (;;) {
        const entry = deferredReferencePages.shift();
        if (!entry) {
          break;
        }
        const currentPage =
          entry.viewItem.pages?.[entry.pageIndex] || entry.page;
        if (!this.hasUnresolvedReferencesToPage(currentPage)) {
          continue;
        }
        let processedPageIndices = this.processedDeferredReferencePages!.get(
          entry.viewItem,
        );
        if (!processedPageIndices) {
          processedPageIndices = new Set();
          this.processedDeferredReferencePages!.set(
            entry.viewItem,
            processedPageIndices,
          );
        }
        processedPageIndices.add(entry.pageIndex);
        await this.resolveUnresolvedReferencesForPage(
          entry.viewItem,
          currentPage,
          entry.pageIndex,
          entry.nextLayoutPosition,
          signal,
        );
      }
    } finally {
      this.resolvingDeferredReferences = false;
      this.processedDeferredReferencePages = null;
    }
    return page;
  }

  private hasUnresolvedReferencesToPage(page: Vtree.Page): boolean {
    return this.counterStore
      .getUnresolvedRefsToPage(page)
      .some((group) => group.refs.some((ref) => !ref.isResolved()));
  }

  private deferReferencesForPage(
    viewItem: OPFViewItem,
    page: Vtree.Page,
    pageIndex: number,
    nextLayoutPosition: Vtree.LayoutPosition | null,
  ): void {
    // The deferred drain is the single retry allowed after the outermost
    // counter scope. Do not let the entry currently being retried enqueue
    // itself again; cascaded pages must still join the active queue.
    if (this.processedDeferredReferencePages?.get(viewItem)?.has(pageIndex)) {
      return;
    }
    const latestPage = viewItem.pages?.[pageIndex] || page;
    if (!this.hasUnresolvedReferencesToPage(latestPage)) {
      return;
    }
    const deferredReferencePages = this.deferredReferencePages;
    const queued = deferredReferencePages.find(
      (entry) => entry.viewItem === viewItem && entry.pageIndex === pageIndex,
    );
    if (queued) {
      queued.page = latestPage;
      queued.nextLayoutPosition = nextLayoutPosition;
    } else {
      deferredReferencePages.push({
        viewItem,
        page: latestPage,
        pageIndex,
        nextLayoutPosition,
      });
    }
  }

  private deferFollowingSpinesForRelayout(spineIndex: number): void {
    this.deferSpinesForRelayoutFrom(spineIndex + 1);
  }

  private deferSpinesForRelayoutFrom(firstSpineIndex: number): void {
    this.deferredFollowingSpineRelayoutStart =
      this.deferredFollowingSpineRelayoutStart == null
        ? firstSpineIndex
        : Math.min(this.deferredFollowingSpineRelayoutStart, firstSpineIndex);
  }

  private removeDeferredReferencePages(
    shouldRemove: (entry: DeferredReferencePage) => boolean,
  ): void {
    // Keep the queue object stable because an active drain holds this array.
    for (
      let deferredIndex = this.deferredReferencePages.length - 1;
      deferredIndex >= 0;
      deferredIndex--
    ) {
      if (shouldRemove(this.deferredReferencePages[deferredIndex])) {
        this.deferredReferencePages.splice(deferredIndex, 1);
      }
    }
  }

  private updateEPageRangesAfterPageCountChange(
    viewItem: OPFViewItem,
    pageCount: number,
  ): void {
    if (!this.opf.epageIsRenderedPage) {
      return;
    }
    const spineIndex = viewItem.item.spineIndex;
    viewItem.item.epageCount = pageCount;
    let nextEPage = viewItem.item.epage + pageCount;
    for (let index = spineIndex + 1; index < this.opf.spine.length; index++) {
      const item = this.opf.spine[index];
      item.epage = nextEPage;
      nextEPage += item.epageCount;
    }
    this.opf.epageCount = this.opf.spine.reduce(
      (count, item) => count + item.epageCount,
      0,
    );
    this.opf.epageCountCallback?.(this.opf.epageCount);
  }

  private rememberDeferredPageReplacement(
    spineIndex: number,
    page: Vtree.Page,
  ): void {
    const replacements = this.deferredPageReplacements;
    let pages = replacements.get(spineIndex);
    if (!pages) {
      pages = [];
      replacements.set(spineIndex, pages);
    }
    if (!pages.includes(page)) {
      pages.push(page);
    }
  }

  private takeDeferredPageReplacement(
    spineIndex: number,
    newPage: Vtree.Page,
  ): Vtree.Page | null {
    const pages = this.deferredPageReplacements.get(spineIndex);
    if (!pages) {
      return null;
    }
    const pageIndex = pages.findIndex(
      (page) =>
        page.offset === newPage.offset &&
        !!page.isBlankPage === !!newPage.isBlankPage,
    );
    if (pageIndex < 0) {
      return null;
    }
    const [page] = pages.splice(pageIndex, 1);
    if (pages.length === 0) {
      this.deferredPageReplacements.delete(spineIndex);
    }
    return page;
  }

  private dispatchPageReplacement(
    oldPage: Vtree.Page,
    newPage: Vtree.Page,
  ): void {
    oldPage.dispatchEvent({
      type: "replaced",
      target: null,
      currentTarget: null,
      preventDefault: null,
      newPage,
    });
  }

  /**
   * Detach stale rendered pages, remembering them so a later rebuilt page can
   * dispatch the `replaced` event to any viewer still displaying them.
   */
  private retireStalePages(spineIndex: number, pages: Vtree.Page[]): void {
    for (const stalePage of pages) {
      this.rememberDeferredPageReplacement(spineIndex, stalePage);
      stalePage.container.remove();
    }
  }

  private clearFollowingSpineRelayoutState(): void {
    this.relayoutingFollowingSpines = false;
    this.relayoutingFollowingSpineStart = null;
    this.notifyRenderChange();
  }

  private flushDeferredPageReplacements(viewItem: OPFViewItem): void {
    const spineIndex = viewItem.item.spineIndex;
    const oldPages = this.deferredPageReplacements.get(spineIndex);
    if (!oldPages) {
      return;
    }
    const newPages = viewItem.pages;
    for (const oldPage of oldPages) {
      const replacement = newPages.reduce<Vtree.Page | null>(
        (closest, page) => {
          if (!closest) {
            return page;
          }
          const distance = Math.abs(page.offset - oldPage.offset);
          const closestDistance = Math.abs(closest.offset - oldPage.offset);
          if (distance !== closestDistance) {
            return distance < closestDistance ? page : closest;
          }
          const sameKind = !!page.isBlankPage === !!oldPage.isBlankPage;
          const closestSameKind =
            !!closest.isBlankPage === !!oldPage.isBlankPage;
          return sameKind && !closestSameKind ? page : closest;
        },
        null,
      );
      if (replacement) {
        this.dispatchPageReplacement(oldPage, replacement);
      }
    }
    this.deferredPageReplacements.delete(spineIndex);
  }

  private updateRetainedTargetCounters(): Set<string> {
    const pages: Vtree.Page[] = [];
    for (const viewItem of this.spineItems) {
      if (viewItem) {
        pages.push(...viewItem.pages);
      }
    }
    const changedTargetIds = new Set<string>();
    this.counterStore.updateTargetCounterNodesInPages(pages, changedTargetIds);
    this.counterStore.updateTargetTextNodesInPages(pages, changedTargetIds);
    this.counterStore.unresolveReferencesForTargets(changedTargetIds);
    return changedTargetIds;
  }

  private async resolveChangedRetainedTargetReferences(
    targetIds: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const targetPages = new Map<
      string,
      {
        viewItem: OPFViewItem;
        page: Vtree.Page;
        pageIndex: number;
        nextLayoutPosition: Vtree.LayoutPosition | null;
      }
    >();
    for (const id of targetIds) {
      const position = this.counterStore.pageIndicesById[id];
      if (!position) continue;
      const viewItem = this.spineItems[position.spineIndex];
      const page = viewItem?.pages[position.pageIndex];
      if (!viewItem || !page) continue;
      const key = `${position.spineIndex}:${position.pageIndex}`;
      targetPages.set(key, {
        viewItem,
        page,
        pageIndex: position.pageIndex,
        nextLayoutPosition:
          viewItem.layoutPositions[position.pageIndex + 1] || null,
      });
    }
    const pages = Array.from(targetPages.values());
    for (const target of pages) {
      this.deferReferencesForPage(
        target.viewItem,
        target.page,
        target.pageIndex,
        target.nextLayoutPosition,
      );
    }
    const first = pages[0];
    if (first) {
      await this.resolveDeferredReferencesAfterCounterScope(
        first.viewItem,
        first.page,
        first.pageIndex,
        first.nextLayoutPosition,
        signal,
      );
    }
  }

  private relayoutDeferredFollowingSpines(): number | null {
    const firstSpine = this.deferredFollowingSpineRelayoutStart;
    if (firstSpine == null) {
      return null;
    }
    this.deferredFollowingSpineRelayoutStart = null;
    this.removeDeferredReferencePages(
      (entry) => entry.viewItem.item.spineIndex >= firstSpine,
    );
    this.counterStore.discardReferencesFromSpine(firstSpine);
    let lastInvalidatedSpine: number | null = null;
    for (
      let spineIndex = firstSpine;
      spineIndex < this.spineItems.length;
      spineIndex++
    ) {
      const viewItem = this.spineItems[spineIndex];
      if (!viewItem) {
        continue;
      }
      lastInvalidatedSpine = spineIndex;
      this.retireStalePages(spineIndex, viewItem.pages);
      this.spineItems[spineIndex] = null;
      this.spineItemLoading[spineIndex] = null;
    }
    this.notifyRenderChange();
    return lastInvalidatedSpine;
  }

  private rerenderDeferredFollowingSpines(
    position: Position,
    context: RenderContext,
  ): Promise<PageAndPosition | null> {
    return this.withRenderLock(context, () =>
      this.rerenderDeferredFollowingSpinesLocked(position, context),
    );
  }

  private async rerenderDeferredFollowingSpinesLocked(
    position: Position,
    context: RenderContext,
  ): Promise<PageAndPosition | null> {
    const spineCount = this.opf?.spine?.length || this.spineItems.length;
    const maxPasses = Math.max(3, spineCount * 2 + 2);
    let passCount = 0;
    let result: PageAndPosition | null = null;

    try {
      for (;;) {
        const firstSpine = this.deferredFollowingSpineRelayoutStart;
        if (firstSpine == null) {
          this.clearFollowingSpineRelayoutState();
          return result;
        }
        passCount++;
        if (passCount > maxPasses) {
          throw new Error("Cross-reference pagination did not stabilize");
        }

        this.relayoutingFollowingSpines = true;
        this.relayoutingFollowingSpineStart = firstSpine;
        const lastInvalidatedSpine = this.relayoutDeferredFollowingSpines();
        const rerenderPosition =
          lastInvalidatedSpine != null
            ? {
                spineIndex: lastInvalidatedSpine,
                pageIndex: Number.POSITIVE_INFINITY,
                offsetInItem: -1,
              }
            : position;
        result = await this.renderPagesUpto(rerenderPosition, false, context);
        const changedTargetIds = this.updateRetainedTargetCounters();
        // Patching generated reference text is insufficient when its width
        // changes. Feed the changed targets back through the existing
        // page-level reference resolver so only retained source pages are
        // re-laid out. If one of those pages shrinks, it queues the following
        // spine suffix for the next pass without discarding the target that
        // supplied the resolved value.
        await this.resolveChangedRetainedTargetReferences(
          changedTargetIds,
          context.signal,
        );
      }
    } catch (err) {
      this.clearFollowingSpineRelayoutState();
      throw err;
    }
  }

  /**
   * Render a single page. If the new page contains elements with ids that are
   * referenced from other pages by 'target-counter()', those pages are rendered
   * too (calling `renderSinglePage` recursively).
   */
  private async renderSinglePage(
    viewItem: OPFViewItem,
    pos: Vtree.LayoutPosition | null,
    signal?: AbortSignal,
  ): Promise<RenderSinglePageResult> {
    const pageIndexToRender = pos ? Math.max(pos.page, 0) : 0;
    const pageNumberContextDepth =
      viewItem.instance.getPageNumberContextDepth();
    // Issue #2013: preserve the current render slot's page number so
    // page-number remains available during target-counter() rerender cleanup.
    viewItem.instance.pushPageNumberContext(pageIndexToRender + 1);
    // Unwind this fallback page-number context also when an error is thrown
    // (or the rendering is canceled).
    try {
      const inCounterResolveScopeAtStart = this.isInCounterResolveScope();
      const oldPage = this.preparePageCountersForRender(
        viewItem,
        pageIndexToRender,
      );
      const prevPage =
        pageIndexToRender > 0 ? viewItem.pages[pageIndexToRender - 1] : null;
      const nextExistingPage = viewItem.pages[pageIndexToRender + 1];
      const page = this.makePage(viewItem, pos);
      this.resolvePageTypeForRenderSlot(
        viewItem,
        page,
        pageIndexToRender,
        oldPage,
        prevPage,
        nextExistingPage,
        inCounterResolveScopeAtStart,
      );

      pos = await runLegacy(
        () => viewItem.instance.layoutNextPage(page, pos),
        "layoutNextPage",
        signal,
      );
      if (!pos) {
        // A rerender can make the final page move to an earlier slot. Remove
        // stale following pages and their saved starts before storing the new
        // final page in the requested slot.
        const finalLength = pageIndexToRender + 1;
        const pageCountChanged = viewItem.pages.length > finalLength;
        if (pageCountChanged) {
          this.updateEPageRangesAfterPageCountChange(viewItem, finalLength);
        }
        this.removeDeferredReferencePages(
          (entry) =>
            entry.viewItem === viewItem && entry.pageIndex >= finalLength,
        );
        for (
          let stalePageIndex = finalLength;
          stalePageIndex < viewItem.pages.length;
          stalePageIndex++
        ) {
          this.counterStore.discardReferencesFromPage(
            viewItem.item.spineIndex,
            stalePageIndex,
          );
        }
        this.retireStalePages(
          viewItem.item.spineIndex,
          viewItem.pages.slice(finalLength),
        );
        viewItem.pages.splice(finalLength);
        viewItem.layoutPositions.splice(finalLength);
        viewItem.pageCounterStarts.splice(finalLength);
        if (pageCountChanged) {
          // A page can shrink while it is recursively rerendered for a target
          // in a later spine. Even during a suffix rebuild, already-rendered
          // following spines then have stale absolute counters and starts, so
          // queue them for the next stabilization pass.
          this.deferFollowingSpinesForRelayout(viewItem.item.spineIndex);
        }
      }
      const pageIndex = pos ? pos.page - 1 : pageIndexToRender;
      this.finishPageContainer(viewItem, page, pageIndex);
      this.counterStore.finishPage(page.spineIndex, pageIndex);
      if (Plugin.getHooksForName(Plugin.HOOKS.PAGINATION_PROGRESS).length) {
        await this.collectTotalOffsets();
      }
      this.reportPaginationProgress(viewItem, pos);

      // If the position of the page break changed, re-layout the following
      // page when needed.
      await this.maybeRelayoutFollowingPage(
        viewItem,
        pos,
        oldPage,
        page,
        signal,
      );
      const resolvedPage = await this.resolveUnresolvedReferencesForPage(
        viewItem,
        page,
        pageIndex,
        pos,
        signal,
      );
      if (!pos && !inCounterResolveScopeAtStart) {
        // A final page can be produced by a nested relayout while
        // resolving a target reference. Mark the spine complete only
        // after that asynchronous work settles, otherwise navigation
        // can start the next spine against counter state still in use.
        this.markSpineItemCompleteIfReady(viewItem);
      }
      return {
        pageAndPosition: makePageAndPosition(resolvedPage, pageIndex),
        nextLayoutPosition: pos,
      };
    } finally {
      viewItem.instance.restorePageNumberContextDepth(pageNumberContextDepth);
    }
  }

  private normalizeSeekPosition(
    position: Position,
    viewItem: OPFViewItem,
  ): Position {
    let pageIndex = position.pageIndex;
    let seekOffset = -1;
    if (pageIndex < 0) {
      seekOffset = position.offsetInItem;

      const seekOffsetPageIndex = Base.binarySearch(
        viewItem.layoutPositions.length,
        (pageIndex) => {
          // 'noLookAhead' argument of getPosition must be true, since
          // otherwise StyleInstance.currentLayoutPosition is modified
          // unintentionally.
          const offset = viewItem.instance.getPosition(
            viewItem.layoutPositions[pageIndex],
            true,
          );
          return offset > seekOffset;
        },
      );
      if (seekOffsetPageIndex === viewItem.layoutPositions.length) {
        if (viewItem.complete) {
          pageIndex = viewItem.pages.length - 1;
        } else {
          // need to search through pages that are not yet produced
          pageIndex = Number.POSITIVE_INFINITY;
        }
      } else {
        // page that contains seekOffset
        pageIndex = seekOffsetPageIndex - 1;
      }
    } else if (
      pageIndex === Number.POSITIVE_INFINITY &&
      position.offsetInItem !== -1
    ) {
      seekOffset = position.offsetInItem;
    }
    return {
      spineIndex: position.spineIndex,
      pageIndex,
      offsetInItem: seekOffset,
    } as Position;
  }

  /**
   * Find a page corresponding to a specified position among already laid out
   * pages.
   * @param sync If true, find the page synchronously (not waiting another
   *     rendering task)
   */
  async findPage(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    const signal = context.signal;
    for (;;) {
      await this.waitForPreviousSpines(position.spineIndex, sync, signal);
      const relayoutingSpine = this.relayoutingFollowingSpineStart;
      if (relayoutingSpine != null && relayoutingSpine <= position.spineIndex) {
        // relayoutDeferredFollowingSpines clears the pending marker before it
        // rebuilds the suffix. Keep navigation behind the in-progress boundary
        // so it cannot observe or concurrently lay out the partial suffix.
        if (sync) {
          return null;
        }
        await this.waitForRenderChange(signal);
        continue;
      }
      const firstInvalidSpine = this.deferredFollowingSpineRelayoutStart;
      if (
        firstInvalidSpine != null &&
        firstInvalidSpine <= position.spineIndex
      ) {
        if (this.renderingAllPages) {
          // Full pagination owns the shared StyleInstance and will consume
          // the suffix marker. Do not let navigation return a cached page
          // from that invalid suffix while the rebuild is still pending.
          if (sync) {
            return null;
          }
          await this.waitForRenderChange(signal);
          continue;
        }
        if (this.renderLock.isHeldByAnother(context.owner)) {
          // Another navigation is already rebuilding the invalid suffix.
          // Retry after it has released the shared layout and counter state.
          if (sync) {
            return null;
          }
          await this.waitForRenderChange(signal);
          continue;
        }
        // A cached page in the invalid suffix must not bypass the deferred
        // rebuild. renderPage() consumes the marker before returning it.
        return this.renderPage(position, context);
      }
      break;
    }
    const viewItem = await this.getPageViewItem(position.spineIndex);
    if (!viewItem) {
      return null;
    }
    let resultPage: Vtree.Page | null = null;
    let pageIndex: number;
    for (;;) {
      const normalizedPosition = this.normalizeSeekPosition(position, viewItem);
      pageIndex = normalizedPosition.pageIndex;
      resultPage = viewItem.pages[pageIndex];
      if (resultPage) {
        break;
      } else if (viewItem.complete) {
        pageIndex = viewItem.pages.length - 1;
        resultPage = viewItem.pages[pageIndex];
        break;
      } else if (sync) {
        const result = await this.renderPage(normalizedPosition, context);
        if (result) {
          resultPage = result.page;
          pageIndex = result.position.pageIndex;
        }
        break;
      } else if (this.renderLock.isHeldByAnother(context.owner)) {
        // A background renderer is already materializing pages. Wait for
        // the requested page to appear instead of rendering the same
        // shared StyleInstance and CounterStore concurrently (Issue #2047).
        await this.waitForRenderChange(signal);
      } else if (
        pageIndex < viewItem.layoutPositions.length &&
        !viewItem.pages[pageIndex]
      ) {
        // The page has a pending layout position that was never
        // materialized (e.g. created during target-text resolution
        // but blocked from cascading, or the spine was recreated
        // during navigation). Render it now instead of polling
        // forever waiting for a nonexistent concurrent task.
        const result = await this.renderPage(normalizedPosition, context);
        if (result) {
          resultPage = result.page;
          pageIndex = result.position.pageIndex;
        }
        break;
      } else {
        // Wait for the layout task and retry
        await this.waitForRenderChange(signal);
      }
    }
    Asserts.assert(resultPage);
    return makePageAndPosition(resultPage, pageIndex);
  }

  /**
   * Renders a page at the specified position. Only one owner at a time renders
   * pages (the shared StyleInstance and CounterStore must not be used
   * concurrently, Issue #2047): a renderer of another owner waits here until
   * the current owner has finished rendering its page.
   */
  async renderPage(
    position: Position,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    return this.withRenderLock(context, () =>
      this.renderPageLocked(position, context),
    );
  }

  private async renderPageLocked(
    position: Position,
    context: RenderContext,
  ): Promise<PageAndPosition | null> {
    try {
      let result = await this.renderPageTracked(position, context.signal);
      const firstSpine = this.deferredFollowingSpineRelayoutStart;
      if (
        !this.renderingAllPages &&
        !this.relayoutingFollowingSpines &&
        firstSpine != null &&
        firstSpine <= position.spineIndex
      ) {
        // In on-demand pagination there is no final renderAllPages pass.
        // Rebuild the invalid suffix only after the current page render
        // has unwound. A changed retained reference can move its source
        // page too, so keep rebuilding the affected suffix until stable.
        await this.rerenderDeferredFollowingSpines(position, context);
        result = await this.renderPageTracked(position, context.signal);
      }
      this.pageSheetSizeTruncator(this.getRenderedPageSizeCount());
      return result;
    } catch (err) {
      this.clearFollowingSpineRelayoutState();
      throw err;
    }
  }

  // Tracks who is rendering pages, so that navigation can wait only until its
  // requested page is available, without canceling background pagination
  // (Issue #2047).
  private renderLock = new RenderLock();

  /**
   * Runs `func` while `context.owner` holds the render lock. A renderer of
   * several pages holds it for the whole run, so that no other renderer (for
   * example, a navigation) can slip in between its pages.
   */
  private async withRenderLock<T>(
    context: RenderContext,
    func: () => Promise<T>,
  ): Promise<T> {
    if (!this.renderLock.tryAcquire(context.owner)) {
      await this.renderLock.acquire(context.owner, context.signal);
    }
    try {
      return await func();
    } finally {
      this.renderLock.release(context.owner);
    }
  }

  private async renderPageTracked(
    position: Position,
    signal?: AbortSignal,
  ): Promise<PageAndPosition | null> {
    const viewItem = await this.getPageViewItem(position.spineIndex);
    if (!viewItem) {
      return null;
    }
    const normalizedPosition = this.normalizeSeekPosition(position, viewItem);
    let pageIndex = normalizedPosition.pageIndex;
    const seekOffset = normalizedPosition.offsetInItem;
    let resultPage = viewItem.pages[pageIndex];
    if (resultPage) {
      return makePageAndPosition(resultPage, pageIndex);
    }
    for (;;) {
      if (pageIndex < viewItem.layoutPositions.length) {
        break;
      }
      if (viewItem.complete) {
        pageIndex = viewItem.pages.length - 1;
        break;
      }
      let pos = viewItem.layoutPositions.at(-1);
      const result = await this.renderSinglePage(viewItem, pos, signal);
      const page = result.pageAndPosition.page;
      pos = result.nextLayoutPosition;
      if (pos) {
        if (seekOffset >= 0) {
          // Searching for offset, don't know the page number.
          const offset = viewItem.instance.getPosition(pos);
          if (offset > seekOffset) {
            resultPage = page;
            pageIndex = viewItem.layoutPositions.length - 2;
            break;
          }
        }
      } else {
        resultPage = page;
        pageIndex = result.pageAndPosition.position.pageIndex;
        // Issue #1498: do not mark complete if layoutPositions and pages
        // are out of sync. A pending layout position means additional
        // page rendering is still required.
        this.markSpineItemCompleteIfReady(viewItem);
        break;
      }
    }
    resultPage = resultPage || viewItem.pages[pageIndex];
    const pos = viewItem.layoutPositions[pageIndex];
    if (resultPage) {
      return makePageAndPosition(resultPage, pageIndex);
    }
    const result = await this.renderSinglePage(viewItem, pos, signal);
    if (!result.nextLayoutPosition) {
      // Issue #1498: keep complete=false while there are pending
      // layout positions without corresponding rendered pages.
      this.markSpineItemCompleteIfReady(viewItem);
    }
    return result.pageAndPosition;
  }

  async renderAllPages(
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    const finalPosition = {
      spineIndex: this.opf.spine.length - 1,
      pageIndex: Number.POSITIVE_INFINITY,
      offsetInItem: -1,
    };
    this.renderingAllPages = true;
    try {
      const result = await this.withRenderLock(context, async () => {
        const initialResult = await this.renderPagesUpto(
          finalPosition,
          false,
          context,
        );
        return this.deferredFollowingSpineRelayoutStart != null
          ? this.rerenderDeferredFollowingSpines(finalPosition, context)
          : initialResult;
      });
      // Wait until all images are loaded (Issue #1321)
      while (
        this.spineItems.some((viewItem) =>
          viewItem?.pages.some((page) =>
            page?.fetchers.some((fetcher) => !fetcher.arrived),
          ),
        )
      ) {
        await sleep(100, context.signal);
      }
      this.pageSheetSizeTruncator(this.getRenderedPageSizeCount());
      return result;
    } catch (err) {
      this.clearFollowingSpineRelayoutState();
      throw err;
    } finally {
      this.renderingAllPages = false;
      this.notifyRenderChange();
    }
  }

  /**
   * Render pages from (spineIndex=0, pageIndex=0) to the specified (spineIndex,
   * pageIndex).
   * @param notAllPages If true, render from biginning of specified spine item.
   */
  async renderPagesUpto(
    position: Position,
    notAllPages: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    if (!position) {
      position = { spineIndex: 0, pageIndex: 0, offsetInItem: 0 };
    }
    const spineIndex = position.spineIndex;
    const pageIndex = position.pageIndex;
    // If notAllPages is true, render pages from biginning of specified spine
    // item.
    let s = notAllPages ? spineIndex : 0;
    return this.withRenderLock(context, async () => {
      let lastResult: PageAndPosition | null = null;
      do {
        const pos = {
          spineIndex: s,
          pageIndex: s === spineIndex ? pageIndex : Number.POSITIVE_INFINITY,
          offsetInItem: s === spineIndex ? position.offsetInItem : -1,
        };
        lastResult = await this.renderPage(pos, context);
      } while (++s <= spineIndex);
      return lastResult;
    });
  }

  /**
   * Move to the first page and render it.
   */
  firstPage(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    return this.findPage(
      { spineIndex: 0, pageIndex: 0, offsetInItem: -1 },
      sync,
      context,
    );
  }

  /**
   * Move to the last page and render it.
   */
  lastPage(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    return this.findPage(
      {
        spineIndex: this.opf.spine.length - 1,
        pageIndex: Number.POSITIVE_INFINITY,
        offsetInItem: -1,
      },
      sync,
      context,
    );
  }

  /**
   * Move to the next page position and render page.
   * @param sync If true, get the page synchronously (not waiting another
   *     rendering task)
   */
  async nextPage(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    let spineIndex = position.spineIndex;
    let pageIndex = position.pageIndex;
    const viewItem = await this.getPageViewItem(spineIndex);
    if (!viewItem) {
      return null;
    }
    if (viewItem.complete && pageIndex == viewItem.pages.length - 1) {
      if (spineIndex >= this.opf.spine.length - 1) {
        return null;
      }
      spineIndex++;
      pageIndex = 0;

      // Remove next viewItem if its first page has same side as the current page
      // to avoid unpaired page.
      const nextViewItem = this.spineItems[spineIndex];
      const nextPage = nextViewItem && nextViewItem.pages[0];
      const currentPage = viewItem.pages.at(-1);
      if (nextPage && currentPage && nextPage.side == currentPage.side) {
        nextViewItem.pages.forEach((page) => {
          if (page.container) page.container.remove();
        });
        this.spineItems[spineIndex] = null;
        this.spineItemLoading[spineIndex] = null;
      }
    } else {
      pageIndex++;
    }
    return this.findPage(
      { spineIndex, pageIndex, offsetInItem: -1 },
      sync,
      context,
    );
  }

  /**
   * Move to the previous page and render it.
   */
  async previousPage(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    let spineIndex = position.spineIndex;
    let pageIndex = position.pageIndex;
    if (pageIndex == 0) {
      if (spineIndex == 0) {
        return null;
      }
      spineIndex--;
      pageIndex = Number.POSITIVE_INFINITY;
    } else {
      pageIndex--;
    }
    return this.findPage(
      { spineIndex, pageIndex, offsetInItem: -1 },
      sync,
      context,
    );
  }

  /**
   * @param page This page should be a currently displayed page.
   */
  private isRectoPage(page: Vtree.Page, position: Position): boolean {
    const isLeft = page.side === Constants.PageSide.LEFT;
    const isLTR =
      this.getCurrentPageProgression(position) ===
      Constants.PageProgression.LTR;
    return (!isLeft && isLTR) || (isLeft && !isLTR);
  }

  /**
   * Get a spread containing the currently displayed page.
   * @param sync If true, get the spread synchronously (not waiting another
   *     rendering task)
   */
  async getSpread(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<Vtree.Spread> {
    const page = this.getPage(position);
    if (!page) {
      return { left: null, right: null };
    }
    const isLeft = page.side === Constants.PageSide.LEFT;
    const otherPageAndPosition = this.isRectoPage(page, position)
      ? await this.previousPage(position, sync, context)
      : await this.nextPage(position, sync, context);
    // this page may be replaced during nextPage(), so get thisPage again.
    const thisPage = this.getPage(position);

    let otherPage = otherPageAndPosition && otherPageAndPosition.page;
    if (otherPage && otherPage.side === thisPage.side) {
      // otherPage must not be same side
      otherPage = null;
    }

    if (isLeft) {
      return { left: thisPage, right: otherPage };
    } else {
      return { left: otherPage, right: thisPage };
    }
  }

  /**
   * Move to the next spread and render pages.
   * @param sync If true, get the spread synchronously (not waiting another
   *     rendering task)
   * @returns The 'verso' page of the next spread.
   */
  async nextSpread(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    const page = this.getPage(position);
    if (!page) {
      return null;
    }
    const isRecto = this.isRectoPage(page, position);
    const next = await this.nextPage(position, sync, context);
    if (isRecto) {
      return next;
    }
    if (!next) {
      return null;
    }
    if (next.page.side === page.side) {
      // If same side, this is the next spread.
      return next;
    }
    const next2 = await this.nextPage(next.position, sync, context);
    // If this is tha last spread, move to next page in the same spread.
    return next2 ?? next;
  }

  /**
   * Move to the previous spread and render pages.
   * @returns The 'recto' page of the previous spread.
   */
  async previousSpread(
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    const page = this.getPage(position);
    if (!page) {
      return null;
    }
    const isRecto = this.isRectoPage(page, position);
    const oldPrevPageCont = page.container.previousElementSibling;
    const prev = await this.previousPage(position, sync, context);
    if (!isRecto) {
      return prev;
    }
    if (!prev) {
      return null;
    }
    if (prev.page.side === page.side) {
      // If same side, this is the previous spread.
      return prev;
    }
    if (prev.page.container !== oldPrevPageCont) {
      // If previous page is changed, return it.
      return prev;
    }
    return this.previousPage(prev.position, sync, context);
  }

  /**
   * Move to the epage specified by the given number (zero-based) and render it.
   */
  async navigateToEPage(
    epage: number,
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    const resolved = await this.opf.resolveEPage(epage);
    return resolved ? this.findPage(resolved, sync, context) : null;
  }

  /**
   * Move to the page specified by the given CFI and render it.
   */
  async navigateToFragment(
    fragment: string,
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    const resolved = await this.opf.resolveFragment(fragment);
    return resolved ? this.findPage(resolved, sync, context) : null;
  }

  private resolveSemanticFootnoteNavigationOffset(
    viewItem: OPFViewItem,
    target: Element,
  ): number | null {
    if (!SemanticFootnote.isSemanticFootnoteElement(target)) {
      return null;
    }
    const targetId = target.getAttribute("id");
    if (!targetId) {
      return null;
    }
    const targetURL = Base.resolveURL(`#${targetId}`, viewItem.xmldoc.url);
    const anchors = viewItem.xmldoc.document.getElementsByTagName("a");
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors.item(i);
      if (!SemanticFootnote.isSemanticFootnoteNoterefElement(anchor)) {
        continue;
      }
      const anchorHref =
        anchor.getAttribute("href") ||
        anchor.getAttributeNS(Base.NS.XLINK, "href");
      if (!anchorHref) {
        continue;
      }
      if (Base.resolveURL(anchorHref, viewItem.xmldoc.url) !== targetURL) {
        continue;
      }
      return viewItem.xmldoc.getElementOffset(anchor);
    }
    return null;
  }

  /**
   * Move to the page specified by the given URL and render it.
   */
  async navigateTo(
    href: string,
    position: Position,
    sync: boolean,
    context: RenderContext = defaultRenderContext(),
  ): Promise<PageAndPosition | null> {
    Logging.logger.debug("Navigate to", href);
    let path = this.opf.getPathFromURL(Base.stripFragment(href));
    if (!path) {
      if (this.opf.opfXML && href.startsWith("#epubcfi(")) {
        // CFI fragment is "relative" to OPF.
        path = this.opf.getPathFromURL(this.opf.opfXML.url);
      } else if (href.startsWith("#")) {
        const restored = this.opf.documentURLTransformer.restoreURL(href);
        if (this.opf.opfXML) {
          path = this.opf.getPathFromURL(restored[0]);
          if (path == null) {
            path = restored[0];
          }
        } else {
          path = restored[0];
        }
        href = restored[0] + (restored[1] ? `#${restored[1]}` : "");
      }
      if (path == null) {
        return null;
      }
    }
    const item = this.opf.itemMapByPath[path];
    if (!item) {
      if (
        this.opf.opfXML &&
        path == this.opf.getPathFromURL(this.opf.opfXML.url)
      ) {
        // CFI link?
        const fragmentIndex = href.indexOf("#");
        if (fragmentIndex >= 0) {
          return this.navigateToFragment(
            href.slice(fragmentIndex + 1),
            position,
            sync,
            context,
          );
        }
      }
      return null;
    }
    await this.waitForPreviousSpines(item.spineIndex, sync, context.signal);
    const viewItem = await this.getPageViewItem(item.spineIndex);
    if (!viewItem) {
      return null;
    }
    const target = viewItem.xmldoc.getElement(href);
    const semanticFootnoteOffset =
      target && this.resolveSemanticFootnoteNavigationOffset(viewItem, target);
    const targetOffset =
      semanticFootnoteOffset != null
        ? semanticFootnoteOffset
        : target
          ? viewItem.xmldoc.getElementOffset(target)
          : 0;
    return this.findPage(
      {
        spineIndex: item.spineIndex,
        pageIndex: -1,
        offsetInItem: targetOffset,
      },
      sync,
      context,
    );
  }

  makePage(
    viewItem: OPFViewItem,
    pos: Vtree.LayoutPosition | null,
  ): Vtree.Page {
    const viewport = viewItem.instance.viewport;
    const pageCont = viewport.document.createElement("div");
    pageCont.setAttribute("data-vivliostyle-page-container", "true");
    pageCont.role = "presentation";

    if (!Constants.isDebug) {
      pageCont.style.visibility = "hidden";
    }
    viewport.layoutBox.appendChild(pageCont);
    const bleedBox = viewport.document.createElement("div");
    bleedBox.setAttribute("data-vivliostyle-bleed-box", "true");
    bleedBox.role = "presentation";
    pageCont.appendChild(bleedBox);
    const page = new Vtree.Page(pageCont, bleedBox);
    page.spineIndex = viewItem.item.spineIndex;
    page.position = pos;
    page.offset = viewItem.instance.getPosition(pos);
    if (
      page.offset === 0 &&
      !(viewItem.instance.blankPageAtStart && viewItem.pages.length === 0)
    ) {
      const id = this.opf.documentURLTransformer.transformFragment(
        "",
        viewItem.item.src,
      );
      bleedBox.setAttribute("id", id);
      page.registerElementWithId(bleedBox, id);
    }
    if (viewport !== this.viewport) {
      const matrix = Exprs.letterbox(
        this.viewport.width,
        this.viewport.height,
        viewport.width,
        viewport.height,
      );
      const cssMatrix = CssParser.parseValue(
        viewItem.instance.style.rootScope,
        new CssTokenizer.Tokenizer(matrix, null),
        "",
      );
      page.delayedItems.push(
        new Vtree.DelayedItem(pageCont, "transform", cssMatrix),
      );
    }
    return page;
  }

  makeObjectView(
    xmldoc: XmlDoc.XMLDocHolder,
    srcElem: Element,
    viewParent: Element,
    computedStyle: { [key: string]: Css.Val },
  ): Element {
    let data = srcElem.getAttribute("data");
    let result: Element | null = null;
    if (data) {
      data = Base.resolveURL(data, xmldoc.url);
      let mediaType = srcElem.getAttribute("media-type");
      if (!mediaType) {
        const path = this.opf.getPathFromURL(data);
        if (path) {
          const item = this.opf.itemMapByPath[path];
          if (item) {
            mediaType = item.mediaType;
          }
        }
      }
      if (mediaType) {
        const handlerSrc = this.opf.bindings[mediaType];
        if (handlerSrc) {
          result = this.viewport.document.createElement("iframe");
          (result as HTMLElement).style.border = "none";
          const srcParam = Base.lightURLEncode(data);
          const typeParam = Base.lightURLEncode(mediaType);
          const sb = new Base.StringBuffer();
          sb.append(handlerSrc);
          sb.append("?src=");
          sb.append(srcParam);
          sb.append("&type=");
          sb.append(typeParam);
          for (let c: Node | null = srcElem.firstChild; c; c = c.nextSibling) {
            if (c.nodeType == 1) {
              const ce = c as Element;
              if (ce.localName == "param" && ce.namespaceURI == Base.NS.XHTML) {
                const pname = ce.getAttribute("name");
                const pvalue = ce.getAttribute("value");
                if (pname && pvalue) {
                  sb.append("&");
                  sb.append(encodeURIComponent(pname));
                  sb.append("=");
                  sb.append(encodeURIComponent(pvalue));
                }
              }
            }
          }
          result.setAttribute("src", sb.toString());
          const width = srcElem.getAttribute("width");
          if (width) {
            result.setAttribute("width", width);
          }
          const height = srcElem.getAttribute("height");
          if (height) {
            result.setAttribute("height", height);
          }
        }
      }
    }
    if (!result) {
      result = this.viewport.document.createElement("object");
      if (data) {
        result.setAttribute("data", Base.resolveWptResourceURL(data));
      }
      result.setAttribute("data-adapt-process-children", "true");
    }

    // Need to cast because we need {Element}, not {!Element}
    return result as Element;
  }

  async makeMathJaxView(
    xmldoc: XmlDoc.XMLDocHolder,
    srcElem: Element,
    viewParent: Element,
    computedStyle: { [key: string]: Css.Val },
  ): Promise<Element | null> {
    // See if MathJax installed, use it if it is.
    const hub = getMathJaxHub();
    if (hub) {
      const doc = viewParent.ownerDocument;
      const span = doc.createElement("span");
      viewParent.appendChild(span);
      const clonedMath = doc.importNode(srcElem, true);
      this.resolveURLsInMathML(clonedMath, xmldoc);
      span.appendChild(clonedMath);
      const queue = hub["queue"];
      queue["Push"](["Typeset", hub, span]);
      return new Promise<Element>((resolve) => {
        queue["Push"](() => {
          resolve(span);
        });
      });
    }
    return null;
  }

  private resolveURLsInMathML(node: Node, xmldoc: XmlDoc.XMLDocHolder) {
    if (node == null) {
      return;
    }
    if (node.nodeType === 1 && (node as Element).tagName === "mglyph") {
      const attrs = Array.from((node as Element).attributes);
      for (const attr of attrs) {
        if (attr.name !== "src") {
          continue;
        }
        const newUrl = Base.resolveURL(attr.nodeValue, xmldoc.url);
        if (attr.namespaceURI) {
          (node as Element).setAttributeNS(
            attr.namespaceURI,
            attr.name,
            newUrl,
          );
        } else {
          (node as Element).setAttribute(attr.name, newUrl);
        }
      }
    }
    if (node.firstChild) {
      this.resolveURLsInMathML(node.firstChild, xmldoc);
    }
    if (node.nextSibling) {
      this.resolveURLsInMathML(node.nextSibling, xmldoc);
    }
  }

  /** @override */

  makeCustomRenderer(xmldoc: XmlDoc.XMLDocHolder): Vgen.CustomRenderer {
    return async (
      srcElem: Element,
      viewParent: Element,
      computedStyle: { [key: string]: Css.Val },
    ): Promise<Element | null> => {
      if (
        srcElem.localName == "object" &&
        srcElem.namespaceURI == Base.NS.XHTML
      ) {
        return this.makeObjectView(xmldoc, srcElem, viewParent, computedStyle);
      } else if (srcElem.namespaceURI == Base.NS.MATHML) {
        return this.makeMathJaxView(xmldoc, srcElem, viewParent, computedStyle);
      } else if (
        (srcElem as HTMLElement).dataset &&
        (srcElem as HTMLElement).dataset["mathTypeset"] == "true"
      ) {
        return this.makeMathJaxView(xmldoc, srcElem, viewParent, computedStyle);
      }
      return null;
    };
  }

  async getPageViewItem(spineIndex: number): Promise<OPFViewItem | null> {
    if (spineIndex === -1 || spineIndex >= this.opf.spine.length) {
      return null;
    }
    const viewItem = this.spineItems[spineIndex];
    if (viewItem) {
      return viewItem;
    }
    // If loading for the item has already been started, wait for the result.
    let loading = this.spineItemLoading[spineIndex];
    if (!loading) {
      loading = this.spineItemLoading[spineIndex] =
        this.loadPageViewItem(spineIndex);
    }
    return loading;
  }

  private async loadPageViewItem(spineIndex: number): Promise<OPFViewItem> {
    const item = this.opf.spine[spineIndex];
    const store = this.opf.store;
    const xmldoc: XmlDoc.XMLDocHolder = await store.load(item.src);
    // EPUB Spine properties support
    const epubSpineProperties = item.itemRefElement.getAttribute("properties");
    if (epubSpineProperties) {
      xmldoc.root.setAttribute(
        "data-vivliostyle-epub-spine-properties",
        epubSpineProperties,
      );
    }
    item.title = xmldoc.document.title;
    const style = store.getStyleForDoc(xmldoc);
    const customRenderer = this.makeCustomRenderer(xmldoc);
    let viewport = this.viewport;
    const viewportSize = style.sizeViewport(
      viewport.width,
      viewport.height,
      viewport.fontSize,
      this.pref,
    );
    if (
      viewportSize.width != viewport.width ||
      viewportSize.height != viewport.height ||
      viewportSize.fontSize != viewport.fontSize
    ) {
      viewport = new Vgen.Viewport(
        viewport.window,
        viewportSize.fontSize,
        viewport.pixelRatio,
        viewport.root,
        viewportSize.width,
        viewportSize.height,
      );
    }
    const isVersoFirstPage = this.spineItems[0]?.instance.isVersoFirstPage;
    const previousViewItem = this.spineItems[spineIndex - 1];
    let pageNumberOffset: number;
    let pageCounterOffset: number;
    if (item.startPage !== null) {
      pageNumberOffset = item.startPage - 1;
      pageCounterOffset = pageNumberOffset;
    } else {
      if (spineIndex > 0 && (!previousViewItem || !previousViewItem.complete)) {
        // When navigate to a new spine item skipping the previous items,
        // give up calculate pageNumberOffset and use epage (or spineIndex if epage is unset).
        pageNumberOffset = item.epage || spineIndex;
        if (
          !this.opf.prePaginated &&
          pageNumberOffset % 2 == (isVersoFirstPage ? 1 : 0)
        ) {
          // Force to odd number to avoid unpaired page. (This is 0 based and even number is recto)
          // (odd and even are reversed if isVersoFirstPage is true)
          pageNumberOffset++;
        }
        pageCounterOffset = pageNumberOffset;
      } else {
        pageNumberOffset = previousViewItem
          ? previousViewItem.instance.pageNumberOffset +
            previousViewItem.pages.length
          : 0;
        // Derive the page counter offset from the previous spine's last
        // rendered page counter start rather than the global
        // currentPageCounters, which may reflect stale state from a later
        // spine that has been destroyed and is being recreated (e.g. after
        // target-text reflow expanded an earlier spine).
        // Note: pageCounterStarts is captured BEFORE updatePageCounters()
        // applies counter-increment, so +1 is added for the standard page
        // auto-increment. Using pageCounterStarts instead of
        // pageCountersById because the latter can be overwritten during
        // resolve-scope cascade re-renders (finishPage), making it
        // unreliable for offset derivation.
        const prevLastPageCounterStarts =
          previousViewItem &&
          previousViewItem.pageCounterStarts[previousViewItem.pages.length - 1];
        const prevLastPageCounters =
          prevLastPageCounterStarts && prevLastPageCounterStarts["page"];
        if (prevLastPageCounters && prevLastPageCounters.length) {
          // pageCounterStarts stores the counter BEFORE auto-increment,
          // so add 1 for the page's own increment.
          pageCounterOffset = prevLastPageCounters.at(-1) + 1;
        } else {
          const counters = this.counterStore.currentPageCounters["page"];
          pageCounterOffset =
            !counters || !counters.length ? pageNumberOffset : counters.at(-1);
        }

        // Note: The "page" counter value differs to the "page-number" value
        // if the "page" counter has been reset by counter-reset/increment.
        // (Fix for issue #701)
      }
      if (item.skipPagesBefore !== null) {
        pageNumberOffset += item.skipPagesBefore;
        pageCounterOffset += item.skipPagesBefore;
      }
    }
    this.counterStore.forceSetPageCounter(pageCounterOffset);
    // For env(pub-title) and env(doc-title)
    const pubTitles = this.opf.metadata && this.opf.metadata[metaTerms.title];
    const pubTitle = (pubTitles && pubTitles[0] && pubTitles[0]["v"]) || "";
    const docTitle = item.title || "";

    const instance = await OPS.StyleInstance.create(
      style,
      xmldoc,
      this.opf.lang,
      viewport,
      this.clientLayout,
      this.fontMapper,
      customRenderer,
      this.opf.fallbackMap,
      pageNumberOffset,
      this.opf.documentURLTransformer,
      this.counterStore,
      this.cmykStore,
      this.pref,
      pubTitle,
      docTitle,
      this.opf.pageProgression,
      isVersoFirstPage,
    );
    if (!this.opf.pageProgression && instance.pageProgression) {
      // Use the first instance's page progression as the global page progression.
      // (Fix for issue #1260)
      this.opf.pageProgression = instance.pageProgression;
    }
    const viewItem: OPFViewItem = {
      item,
      xmldoc,
      instance,
      layoutPositions: [null],
      pages: [],
      complete: false,
      pageCounterStarts: [],
    };
    this.spineItems[spineIndex] = viewItem;
    return viewItem;
  }

  removeRenderedPages() {
    const items = this.spineItems;
    for (const item of items) {
      if (item) {
        item.pages.splice(0);
      }
    }
    this.viewport.clear();
  }

  /**
   * Returns if at least one page has 'auto' size
   */
  hasAutoSizedPages(): boolean {
    const items = this.spineItems;
    for (const item of items) {
      if (item) {
        const pages = item.pages;
        for (const page of pages) {
          if (page.isAutoPageWidth && page.isAutoPageHeight) {
            return true;
          }
        }
      }
    }
    return false;
  }

  hasPages(): boolean {
    return this.spineItems.some((item) => item && item.pages.length > 0);
  }

  async showTOC(autohide: boolean): Promise<Vtree.Page | null> {
    const opf = this.opf;
    const toc = opf.toc;
    this.tocAutohide = autohide;
    if (!toc) {
      return null;
    }
    this.tocVisible = true;
    if (this.tocView && this.tocView.page) {
      this.tocView.page.container.style.visibility = "visible";
      this.tocView.page.container.setAttribute("aria-hidden", "false");
      return this.tocView.page;
    }
    if (!this.tocView) {
      this.tocView = new Toc.TOCView(
        opf.store,
        toc.src,
        opf.lang,
        this.clientLayout,
        this.fontMapper,
        this.pref,
        this,
        opf.fallbackMap,
        opf.documentURLTransformer,
        this.counterStore,
        this.cmykStore,
      );
    }
    const viewport = this.viewport;
    const tocWidth = Math.min(344, Math.round(0.67 * viewport.width) - 16);
    const tocHeight = viewport.height - 6;
    const pageCont = viewport.document.createElement("div") as HTMLElement;
    viewport.root.appendChild(pageCont);
    // pageCont.style.position = "absolute";
    if (!Constants.isDebug) {
      pageCont.style.visibility = "hidden";
    }
    // pageCont.style.left = "3px";
    // pageCont.style.top = "3px";
    pageCont.style.width = `${tocWidth + 16}px`;
    pageCont.style.maxHeight = `${tocHeight}px`;
    // pageCont.style.overflow = "scroll";
    // pageCont.style.overflowX = "hidden";
    // pageCont.style.background = "rgba(248,248,248,0.9)";
    // pageCont.style["borderRadius"] = "2px";
    // pageCont.style["boxShadow"] = "1px 1px 2px rgba(0,0,0,0.4)";

    pageCont.setAttribute("data-vivliostyle-toc-box", "true");
    pageCont.setAttribute("role", "navigation");

    const page = await this.tocView.showTOC(
      pageCont,
      viewport,
      tocWidth,
      tocHeight,
      this.viewport.fontSize,
    );
    pageCont.style.visibility = "visible";
    pageCont.setAttribute("aria-hidden", "false");
    return page;
  }

  hideTOC(): void {
    this.tocVisible = false;
    if (this.tocView) {
      this.tocView.hideTOC();
    }
  }

  isTOCVisible(): boolean {
    return this.tocVisible && !!this.tocView && this.tocView.isTOCVisible();
  }
}

/**
 * Identifies who is rendering pages. At most one owner renders pages at a time
 * (see `RenderLock`); the same owner may render nested pages.
 */
export type RenderOwner = object;

export interface RenderContext {
  owner: RenderOwner;
  /** Aborted to cancel the rendering. */
  signal?: AbortSignal;
}

/**
 * The context for callers that do not give one: a new owner, so that the
 * rendering of the caller (and what it calls) counts as one owner.
 */
export function defaultRenderContext(): RenderContext {
  return { owner: {} };
}

/**
 * Mutual exclusion of page rendering between owners (Issue #2047). Reentrant
 * for the owner that holds it; waiting owners are served in order.
 */
export class RenderLock {
  private holder: RenderOwner | null = null;
  private depth = 0;
  private waiters: { owner: RenderOwner; grant: () => void }[] = [];
  private changeListeners: (() => void)[] = [];

  isHeldByAnother(owner: RenderOwner): boolean {
    return this.holder !== null && this.holder !== owner;
  }

  /** Takes the lock at once if it is free or held by `owner`. */
  tryAcquire(owner: RenderOwner): boolean {
    if (this.holder === null || this.holder === owner) {
      this.holder = owner;
      this.depth++;
      return true;
    }
    return false;
  }

  /** Waits until the lock is handed over to `owner`. */
  acquire(owner: RenderOwner, signal?: AbortSignal): Promise<void> {
    if (this.tryAcquire(owner)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const waiter = {
        owner,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(owner: RenderOwner): void {
    if (this.holder !== owner || this.depth === 0) {
      return;
    }
    if (--this.depth > 0) {
      return;
    }
    this.holder = null;
    const next = this.waiters.shift();
    if (next) {
      this.holder = next.owner;
      this.depth = 1;
      next.grant();
    }
    this.notify();
  }

  /**
   * Waits until `notify()` is called (the lock is released, or something that
   * a waiter depends on has changed), at most `timeout` milliseconds.
   */
  changed(timeout: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.changeListeners.indexOf(wake);
        if (index >= 0) {
          this.changeListeners.splice(index, 1);
        }
      };
      const wake = () => {
        stop();
        resolve();
      };
      const onAbort = () => {
        stop();
        reject(signal!.reason);
      };
      const timer = setTimeout(wake, timeout);
      this.changeListeners.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  notify(): void {
    for (const wake of this.changeListeners.slice()) {
      wake();
    }
  }
}

export interface RenderSinglePageResult {
  pageAndPosition: PageAndPosition;
  nextLayoutPosition: Vtree.LayoutPosition | null;
}
