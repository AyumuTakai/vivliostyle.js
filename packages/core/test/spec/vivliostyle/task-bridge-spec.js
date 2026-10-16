import * as adapt_task from "../../../src/vivliostyle/task";
import * as adapt_bridge from "../../../src/vivliostyle/task-bridge";
import * as adapt_taskutil from "../../../src/vivliostyle/task-util";

// A legacy-style function that creates a frame and completes asynchronously.
function legacyIncrement(x, delay) {
  var frame = adapt_task.newFrame("legacyIncrement");
  frame.sleep(delay).then(function () {
    frame.finish(x + 1);
  });
  return frame.result();
}

describe("task-bridge", function () {
  describe("runLegacy", function () {
    it("runs a legacy function and resolves with its result", async function () {
      expect(
        await adapt_bridge.runLegacy(function () {
          return legacyIncrement(41, 1);
        }),
      ).toBe(42);
    });

    it("resolves with the value of an already available Result", async function () {
      expect(
        await adapt_bridge.runLegacy(function () {
          return adapt_task.newResult("sync");
        }),
      ).toBe("sync");
    });

    it("rejects when the legacy function fails", async function () {
      await expectAsync(
        adapt_bridge.runLegacy(function () {
          var frame = adapt_task.newFrame("failing");
          frame.sleep(1).then(function () {
            throw new Error("legacy error");
          });
          return frame.result();
        }),
      ).toBeRejectedWithError("legacy error");
    });
  });

  describe("fromPromise", function () {
    it("lets legacy code wait for a Promise", async function () {
      var result = await new Promise(function (resolve) {
        adapt_task.start(function () {
          var frame = adapt_task.newFrame("caller");
          adapt_bridge
            .fromPromise(adapt_taskutil.sleep(2).then(() => 40))
            .then(function (v) {
              resolve(v + 2);
              frame.finish(v + 2);
            });
          return frame.result();
        });
      });
      expect(result).toBe(42);
    });

    it("delivers a rejection to the Task.handle error handler of the caller", async function () {
      var message = await new Promise(function (resolve) {
        adapt_task.start(function () {
          return adapt_task.handle(
            "caller",
            function (frame) {
              adapt_bridge
                .fromPromise(Promise.reject(new Error("async error")))
                .then(function () {
                  frame.finish("no error");
                });
            },
            function (frame, err) {
              resolve(err.message);
              frame.finish("handled");
            },
          );
        });
      });
      expect(message).toBe("async error");
    });
  });

  describe("crossing the boundary does not wait for the scheduler", function () {
    it("runLegacy starts the legacy function before it returns", async function () {
      var started = false;
      var promise = adapt_bridge.runLegacy(function () {
        started = true;
        return adapt_task.newResult(7);
      });
      expect(started).toBe(true);
      expect(await promise).toBe(7);
    });

    it("fromPromise resumes the legacy task before the next timer", async function () {
      var order = [];
      setTimeout(function () {
        order.push("timer");
      }, 0);
      await new Promise(function (resolve) {
        adapt_task.startNow(function () {
          var frame = adapt_task.newFrame("caller");
          adapt_bridge.fromPromise(Promise.resolve(1)).then(function () {
            order.push("resumed");
            resolve();
            frame.finish(true);
          });
          return frame.result();
        });
      });
      expect(order).toEqual(["resumed"]);
    });

    it("keeps the time slice measured from the moment the task resumes", async function () {
      // A legacy task that asks for a time slice right after being resumed
      // must not be asked to yield because of a stale slice.
      var scheduler = adapt_task.newScheduler();
      scheduler.setSlice(1000);
      var yielded = await new Promise(function (resolve) {
        scheduler.run(
          function () {
            var frame = adapt_task.newFrame("caller");
            adapt_bridge.fromPromise(adapt_taskutil.sleep(5)).then(function () {
              var slice = frame.timeSlice();
              resolve(slice.isPending());
              frame.finish(true);
            });
            return frame.result();
          },
          "slice",
          true,
        );
      });
      expect(yielded).toBe(false);
    });
  });

  describe("fetcherResult / waitForFetchersResult", function () {
    it("are synchronous when everything has arrived", async function () {
      var fetcher = new adapt_taskutil.Fetcher(async () => "R");
      await fetcher.get();
      var seen = [];
      await new Promise(function (resolve) {
        adapt_task.start(function () {
          var frame = adapt_task.newFrame("caller");
          adapt_bridge.fetcherResult(fetcher).then(function (v) {
            seen.push(v);
          });
          adapt_bridge.waitForFetchersResult([fetcher]).then(function (v) {
            seen.push(v);
          });
          // Both callbacks ran synchronously, before this line.
          expect(seen).toEqual(["R", true]);
          resolve();
          frame.finish(true);
          return frame.result();
        });
      });
    });

    it("wait for fetchers that have not arrived yet", async function () {
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        await adapt_taskutil.sleep(5);
        return "late";
      });
      var result = await new Promise(function (resolve) {
        adapt_task.start(function () {
          var frame = adapt_task.newFrame("caller");
          adapt_bridge.waitForFetchersResult([fetcher]).then(function () {
            adapt_bridge.fetcherResult(fetcher).then(function (v) {
              resolve(v);
              frame.finish(true);
            });
          });
          return frame.result();
        });
      });
      expect(result).toBe("late");
    });
  });
});
