/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Daishinsha Inc.
 * Copyright 2019 Vivliostyle Foundation
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
 * @fileoverview Net - Fetch resource from a URL.
 */
import * as Base from "./base";
import * as Logging from "./logging";
import * as Task from "./task";
import { fromPromise } from "./task-bridge";
import * as TaskUtil from "./task-util";
import { Net, XmlDoc } from "./types";
import { UserAgentXml } from "./assets";

/**
 * @enum {string}
 */
export enum FetchResponseType {
  ARRAYBUFFER = "arraybuffer",
  BLOB = "blob",
  DOCUMENT = "document",
  JSON = "json",
  TEXT = "text",
}

export type FetchResponse = Net.FetchResponse;

export async function fetchFromURL(
  url: string,
  opt_type?: FetchResponseType,
  opt_method?: string,
): Promise<FetchResponse> {
  const requestInit: RequestInit = {
    method: opt_method || "GET",
    mode: "cors",
  };

  const response: FetchResponse = {
    status: 0,
    statusText: "",
    url,
    contentType: null,
    responseText: null,
    responseXML: null,
    responseBlob: null,
  };

  try {
    const res = await fetch(url, requestInit);
    response.status = res.status;
    response.url = res.url;
    response.statusText = res.statusText;
    response.contentType =
      res.headers.get("Content-Type")?.replace(/;.*$/, "").toLowerCase() ??
      null;

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
      );
    }

    let fetchedContent: Blob | ArrayBuffer | string | Base.JSON;
    if (opt_type === FetchResponseType.BLOB) {
      fetchedContent = await res.blob();
    } else if (opt_type === FetchResponseType.ARRAYBUFFER) {
      fetchedContent = await res.arrayBuffer();
    } else if (opt_type === FetchResponseType.JSON) {
      fetchedContent = await res.json();
    } else if (
      // Aozorabunko's (X)HTML support
      /\/aozorabunko\/[^/]+\/cards\/[^/]+\/files\/[^/.]+\.html$/.test(url)
    ) {
      response.contentType = "text/html";
      const buffer = await res.arrayBuffer();
      const decoder = new TextDecoder("Shift_JIS");
      fetchedContent = decoder.decode(buffer);
    } else {
      // Treat `data:,<h1>Hello</h1>` as text/html
      if (/^data:,(<|%3c)/i.test(url)) {
        response.contentType = "text/html";
      }
      fetchedContent = await res.text();
    }

    if (opt_type === FetchResponseType.BLOB && fetchedContent instanceof Blob) {
      response.responseBlob = fetchedContent;
    } else if (
      opt_type === FetchResponseType.ARRAYBUFFER &&
      fetchedContent instanceof ArrayBuffer
    ) {
      response.responseBlob = makeBlob([fetchedContent]);
    } else if (opt_type === FetchResponseType.JSON) {
      response.responseText = JSON.stringify(fetchedContent);
    } else if (typeof fetchedContent === "string") {
      response.responseText = fetchedContent;
    }
  } catch (e) {
    if (response.status >= 400) {
      Logging.logger.warn(
        `Error fetching ${url} (${response.status}${
          response.statusText ? " " + response.statusText : ""
        })`,
      );
    } else {
      Logging.logger.warn(e, `Error fetching ${url}`);
    }
  }
  return response;
}

export function makeBlob(parts: BlobPart[], opt_type?: string): Blob {
  const type = opt_type || "application/octet-stream";
  return new Blob(parts, { type });
}

export function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

/**
 * @return url
 */
export function createObjectURL(blob: Blob): string {
  return URL.createObjectURL(blob);
}

/**
 * @template Resource
 */
export class ResourceStore<Resource> implements Net.ResourceStore<Resource> {
  resources: { [key: string]: Resource | null } = {};
  fetchers: { [key: string]: TaskUtil.Fetcher<Resource | null> } = {};

  constructor(
    public readonly parser: (
      p1: FetchResponse,
      p2: ResourceStore<Resource>,
    ) => Promise<Resource | null>,
    public readonly type: FetchResponseType,
  ) {}

  /**
   * @return resource for the given URL
   */
  async load(
    url: string,
    opt_required?: boolean,
    opt_message?: string,
  ): Promise<Resource | null> {
    url = Base.stripFragment(url);
    const resource = this.resources[url];
    if (typeof resource != "undefined") {
      return resource;
    }
    return this.fetch(url, opt_required, opt_message).get();
  }

  /**
   * Same as `load`, for the code that still uses Task/Result. The Result is
   * available at once if the resource has already been loaded.
   */
  loadResult(
    url: string,
    opt_required?: boolean,
    opt_message?: string,
  ): Task.Result<Resource | null> {
    const resource = this.resources[Base.stripFragment(url)];
    if (typeof resource != "undefined") {
      return Task.newResult(resource);
    }
    return fromPromise(
      this.load(url, opt_required, opt_message),
      "ResourceStore.load",
    );
  }

  private async fetchInner(
    url: string,
    opt_required?: boolean,
    opt_message?: string,
  ): Promise<Resource | null> {
    // Hack for TOCView.showTOC()
    const isTocBox = Base.isTocBoxURL(url);
    if (isTocBox) {
      url = Base.stripTocBoxURL(url);
    }
    const userAgentXmlUrl = Base.resolveURL(
      "user-agent.xml",
      Base.resourceBaseURL,
    );
    const isUserAgentXml = !isTocBox && url === userAgentXmlUrl;
    if (isUserAgentXml) {
      // Change "user-agent.xml" URL to data URL
      url = `data:application/xml,${encodeURIComponent(UserAgentXml)}`;
    }

    const response = await fetchFromURL(url, this.type);
    if (response.status >= 400) {
      if (opt_required) {
        throw new Error(
          (opt_message || `Failed to fetch required resource: ${url}`) +
            ` (${response.status}${
              response.statusText ? " " + response.statusText : ""
            })`,
        );
      }
    }
    if (isTocBox) {
      // Hack for TOCView.showTOC()
      url = Base.toTocBoxURL(url);
      response.url = Base.toTocBoxURL(response.url);
    } else if (isUserAgentXml) {
      // Restore "user-agent.xml" URL
      response.url = url = userAgentXmlUrl;
    }
    const resource = await this.parser(response, this);
    delete this.fetchers[url];
    this.resources[url] = resource;
    return resource;
  }

  /**
   * @return fetcher for the resource for the given URL
   */
  fetch(
    url: string,
    opt_required?: boolean,
    opt_message?: string,
  ): TaskUtil.Fetcher<Resource | null> | null {
    url = Base.stripFragment(url);
    const resource = this.resources[url];
    if (resource) {
      return null;
    }
    let fetcher = this.fetchers[url];
    if (!fetcher) {
      fetcher = new TaskUtil.Fetcher(
        () => this.fetchInner(url, opt_required, opt_message),
        `Fetch ${url}`,
      );
      this.fetchers[url] = fetcher;
      fetcher.start();
    }
    return fetcher;
  }

  get(url: string): XmlDoc.XMLDocHolder {
    const resource: unknown = this.resources[Base.stripFragment(url)];
    return resource as XmlDoc.XMLDocHolder;
  }

  delete(url: string) {
    delete this.resources[Base.stripFragment(url)];
  }
}

export type JSONStore = ResourceStore<Base.JSON>;

export async function parseJSONResource(
  response: FetchResponse,
  store: JSONStore,
): Promise<Base.JSON> {
  const text = response.responseText;
  return text ? Base.stringToJSON(text) : null;
}

export function newJSONStore(): JSONStore {
  return new ResourceStore(parseJSONResource, FetchResponseType.TEXT);
}

/**
 * @return holding event type (load/error/abort)
 */
export function loadElement(
  elem: Element,
  src?: string,
  alt?: string | null,
): TaskUtil.Fetcher<string> {
  const fetcher = new TaskUtil.Fetcher<string>(
    () =>
      new Promise<string>((resolve) => {
        let done = false;
        let timeoutId: number | null = null;
        const handler = (evt: Event) => {
          if (done) {
            return;
          } else {
            done = true;
          }
          // Clear timeout to prevent unnecessary callback execution
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          resolve(evt ? evt.type : "timeout");
        };
        elem.addEventListener("load", handler, false);
        elem.addEventListener("error", handler, false);
        elem.addEventListener("abort", handler, false);
        if (elem.namespaceURI == Base.NS.SVG) {
          if (src) {
            elem.setAttributeNS(Base.NS.XLINK, "xlink:href", src);
          }
          // SVG handlers are not reliable
          timeoutId = setTimeout(handler, 300);
        } else if (elem.localName === "script") {
          timeoutId = setTimeout(handler, 3000);
        } else if (src) {
          if (elem.localName === "img") {
            const imgElem = elem as HTMLImageElement;
            // Remove loading="lazy" attribute to ensure images load immediately
            // for proper pagination (Vivliostyle needs image dimensions for layout)
            if (imgElem.loading === "lazy") {
              imgElem.loading = "eager";
            }
            imgElem.src = src;
            if (alt) {
              imgElem.alt = alt;
            }
            // Handle already cached images
            if (imgElem.complete) {
              // Image already loaded (from cache)
              setTimeout(() => handler(new Event("load")), 0);
            } else {
              // Set a longer timeout to handle slow networks and large images
              timeoutId = setTimeout(handler, 30000);
            }
          } else {
            (elem as any).src = src;
            if (alt) {
              (elem as any).alt = alt;
            }
          }
        } else if (
          elem.localName === "img" ||
          elem.localName === "embed" ||
          elem.localName === "object" ||
          elem.localName === "iframe"
        ) {
          // No src provided: element already has its source attributes set
          // (e.g., <img srcset="...">, <embed src="...">, <object data="...">).
          // Check if already loaded and set a timeout as a safety net.
          if ((elem as HTMLImageElement).complete) {
            setTimeout(() => handler(new Event("load")), 0);
          } else {
            timeoutId = setTimeout(handler, 30000);
          }
        }
      }),
    `loadElement ${src || elem.localName}`,
  );
  fetcher.start();
  return fetcher;
}
