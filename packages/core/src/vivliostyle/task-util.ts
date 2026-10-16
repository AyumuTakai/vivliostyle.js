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
 * @fileoverview TaskUtil - Utilities for asynchronous execution.
 */
import * as Logging from "./logging";

/**
 * Wait for the given time.
 * @param delay in milliseconds.
 */
export const sleep = (delay: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delay));

/**
 * Length of a time slice in milliseconds. Code that runs for a long time
 * without waiting for anything should call `timeSlice()` in its loop.
 */
const TIME_SLICE = 25;
let sliceOverTime = 0;

/**
 * Yields to the event loop (so that the browser can render and handle events)
 * if the current time slice is over; otherwise returns at once.
 */
export async function timeSlice(): Promise<void> {
  const now = performance.now();
  if (sliceOverTime === 0) {
    // First call: the slice started when the caller started to run.
    sliceOverTime = now + TIME_SLICE;
  }
  if (now >= sliceOverTime) {
    Logging.logger.debug("-- time slice --");
    await sleep(0);
    sliceOverTime = performance.now() + TIME_SLICE;
  }
}

/**
 * A class that can fetch or compute a resource that may be needed by multiple
 * callers. The first time a resource is requested, it is fetched and then given
 * to everyone requesting it.
 *
 * A failed fetch rejects the Promise returned by `get()`; `piggyback`
 * callbacks are not called in that case.
 * @template T
 * @param fetch function that fetches/computes a resource
 */
export class Fetcher<T> {
  name: string | undefined;
  arrived: boolean = false;
  resource: T | null = null;
  private promise: Promise<T> | null = null;
  private piggybacks: ((p1: T) => void)[] = [];
  private fetch: (() => Promise<T>) | null;

  constructor(fetch: () => Promise<T>, opt_name?: string) {
    this.fetch = fetch;
    this.name = opt_name;
  }

  /**
   * Start fetching/computing a resource, don't block the caller.
   */
  start(): void {
    if (!this.promise && this.fetch) {
      const fetch = this.fetch;
      this.fetch = null;
      // Like the former task-based implementation, run the fetch function
      // after the caller has finished its current synchronous work (for
      // example, a caller may set up an element after creating a fetcher for
      // it, and the fetch function then sets `src` on the element).
      this.promise = Promise.resolve()
        .then(fetch)
        .then((resource) => {
          const piggybacks = this.piggybacks;
          this.arrived = true;
          this.resource = resource;
          this.piggybacks = [];
          for (const piggyback of piggybacks) {
            try {
              piggyback(resource);
            } catch (err) {
              Logging.logger.error(err, "Error:");
            }
          }
          return resource;
        });
      // Log a failure even if nobody waits for the resource (as the former
      // task-based implementation did), and keep it from being reported as an
      // unhandled rejection. `get()` still rejects for callers who wait.
      this.promise.catch((err) => {
        Logging.logger.error(err, "Unhandled exception in fetcher", this.name);
      });
    }
  }

  piggyback(fn: (p1: T) => void): void {
    if (this.arrived) {
      fn(this.resource);
    } else {
      this.piggybacks.push(fn);
    }
  }

  /**
   * Fetches the resource, waits for it to arrive if it is already being
   * fetched.
   */
  get(): Promise<T> {
    this.start();
    return this.promise;
  }

  hasArrived(): boolean {
    return this.arrived;
  }
}

/**
 * Wait for all Fetcher objects in the array to arrive
 */
export const waitForFetchers = async <T>(
  fetchers: Fetcher<T>[],
): Promise<boolean> => {
  for (const fetcher of fetchers) {
    await fetcher.get();
  }
  return true;
};
