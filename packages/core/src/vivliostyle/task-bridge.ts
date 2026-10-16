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
 *
 * @fileoverview TaskBridge - Adapters between the legacy Task/Result machinery
 * (task.ts) and Promise/async-await, so that modules can be migrated to
 * async/await one at a time, from the leaves of the call graph upward.
 *
 * Rules that make the bridge necessary:
 *
 * - Legacy functions (those that call `Task.newFrame`) need an ambient task
 *   context. That context exists only while the scheduler runs a task's
 *   continuation, so an async function cannot call a legacy function
 *   directly: use `runLegacy`.
 * - A legacy `Result` can be consumed only once, and its callback runs
 *   synchronously when the result is already available, while `await` always
 *   yields a microtask. Keep synchronous fast paths (see `fetcherResult`).
 * - A crossing from legacy code to a Promise (`fromPromise`) or from async
 *   code to a legacy task (`runLegacy`) does not wait for the scheduler's
 *   timer: a legacy function that runs from async code starts at once, and a
 *   legacy task resumes in the microtask that follows the Promise. It still
 *   costs a Promise and a microtask, so avoid it in the innermost loops.
 *
 * Delete this file when no legacy code is left.
 */
import * as Task from "./task";
import type { Fetcher } from "./task-util";
import { waitForFetchers } from "./task-util";

class Rejection {
  constructor(public readonly error: Error) {}
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * For legacy code: wait for a Promise. Must be called inside a task. A
 * rejection is re-thrown in the task context when the consumer resumes, so
 * `Task.handle` error handlers see it.
 */
export function fromPromise<T>(
  promise: Promise<T>,
  name: string = "fromPromise",
): Task.Result<T> {
  const frame = Task.newFrame<T>(name);
  const continuation = frame.suspend(name);
  const originalThen = frame.then.bind(frame);
  frame.then = (callback: (p1: T) => void) =>
    originalThen((value: T | Rejection) => {
      if (value instanceof Rejection) {
        throw value.error;
      }
      callback(value);
    });
  // Resume the task as soon as the promise settles, not through the
  // scheduler's timer: the timer would add at least 1 ms to every crossing.
  promise.then(
    (value) => continuation.resumeNow(value),
    (e) => continuation.resumeNow(new Rejection(toError(e)) as unknown as T),
  );
  return frame.result();
}

/**
 * For async code: wait for a legacy Result. Must be called synchronously
 * inside a task (the callback has to be registered in the task context).
 */
export function toPromise<T>(
  result: Task.Result<T>,
  name: string = "toPromise",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    Task.handle<T>(
      name,
      (frame) => {
        result.then((value) => {
          resolve(value);
          frame.finish(value);
        });
      },
      (frame, err) => {
        reject(err);
        frame.finish(null as T);
      },
    );
  });
}

/**
 * For async code: call a legacy function. The function runs as a task of its
 * own, because legacy code needs the ambient task context.
 */
export function runLegacy<T>(
  func: () => Task.Result<T>,
  name: string = "runLegacy",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    Task.startNow(
      () =>
        Task.handle<T>(
          name,
          (frame) => {
            func().then((value) => {
              resolve(value);
              frame.finish(value);
            });
          },
          (frame, err) => {
            reject(err);
            frame.finish(null as T);
          },
        ),
      name,
    );
  });
}

/**
 * For legacy code: the resource of a Fetcher as a Result. Synchronous if the
 * resource has already arrived.
 */
export function fetcherResult<T>(fetcher: Fetcher<T>): Task.Result<T> {
  return fetcher.hasArrived()
    ? Task.newResult(fetcher.resource as T)
    : fromPromise(fetcher.get(), "Fetcher.get");
}

/**
 * For legacy code: wait for all fetchers as a Result. Synchronous if all of
 * them have already arrived.
 */
export function waitForFetchersResult<T>(
  fetchers: Fetcher<T>[],
): Task.Result<boolean> {
  return fetchers.every((fetcher) => fetcher.hasArrived())
    ? Task.newResult(true)
    : fromPromise(waitForFetchers(fetchers), "waitForFetchers");
}
