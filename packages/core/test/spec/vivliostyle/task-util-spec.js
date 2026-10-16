import * as adapt_logging from "../../../src/vivliostyle/logging";
import * as adapt_taskutil from "../../../src/vivliostyle/task-util";

describe("task-util", function () {
  describe("Fetcher", function () {
    it("starts its fetch function once", async function () {
      var callCount = 0;
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        callCount++;
        return "result";
      });

      fetcher.start();
      await fetcher.get();
      fetcher.start();
      await adapt_taskutil.sleep(0);
      expect(callCount).toBe(1);
    });

    it("gives the same resource to everyone requesting it", async function () {
      var callCount = 0;
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        callCount++;
        await adapt_taskutil.sleep(5);
        return { id: 1 };
      });

      var results = await Promise.all([
        fetcher.get(),
        fetcher.get(),
        fetcher.get(),
      ]);
      expect(callCount).toBe(1);
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
      expect(fetcher.hasArrived()).toBe(true);
      expect(fetcher.resource).toBe(results[0]);
    });

    it("calls piggyback functions on arrival, or at once if it has arrived", async function () {
      var calls = [];
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        await adapt_taskutil.sleep(5);
        return "A";
      });
      fetcher.piggyback(function (r) {
        calls.push("before:" + r);
      });
      fetcher.start();
      expect(calls).toEqual([]);
      await fetcher.get();
      expect(calls).toEqual(["before:A"]);
      fetcher.piggyback(function (r) {
        calls.push("after:" + r);
      });
      expect(calls).toEqual(["before:A", "after:A"]);
    });

    it("keeps calling piggyback functions when one of them throws", async function () {
      var calls = [];
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        return "A";
      });
      fetcher.piggyback(function () {
        throw new Error("piggyback error (expected in this test)");
      });
      fetcher.piggyback(function (r) {
        calls.push(r);
      });
      await fetcher.get();
      expect(calls).toEqual(["A"]);
    });

    it("logs a failure that nobody waits for", async function () {
      spyOn(adapt_logging.logger, "error");
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        throw new Error("lost network");
      }, "lost");
      fetcher.start();
      await adapt_taskutil.sleep(5);
      expect(adapt_logging.logger.error).toHaveBeenCalledTimes(1);
      expect(adapt_logging.logger.error.calls.argsFor(0)[0].message).toBe(
        "lost network",
      );
    });

    it("does not log a failure that a caller waits for", async function () {
      spyOn(adapt_logging.logger, "error");
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        throw new Error("lost network");
      });
      await expectAsync(fetcher.get()).toBeRejectedWithError("lost network");
      await adapt_taskutil.sleep(5);
      expect(adapt_logging.logger.error).not.toHaveBeenCalled();
    });

    it("rejects get() when the fetch fails", async function () {
      var fetcher = new adapt_taskutil.Fetcher(async function () {
        throw new Error("network error");
      });
      await expectAsync(fetcher.get()).toBeRejectedWithError("network error");
      expect(fetcher.hasArrived()).toBe(false);
    });
  });

  describe("timeSlice", function () {
    it("returns at once while the time slice is not over", async function () {
      await adapt_taskutil.timeSlice(); // starts a slice
      var yielded = false;
      setTimeout(function () {
        yielded = true;
      }, 0);
      await adapt_taskutil.timeSlice();
      expect(yielded).toBe(false);
    });

    it("yields to the event loop when the time slice is over", async function () {
      await adapt_taskutil.timeSlice(); // starts a slice
      var yielded = false;
      setTimeout(function () {
        yielded = true;
      }, 0);
      var end = performance.now() + 40;
      while (performance.now() < end) {
        // busy loop: the slice (25 ms) is over
      }
      await adapt_taskutil.timeSlice();
      expect(yielded).toBe(true);
    });
  });

  describe("waitForFetchers", function () {
    it("resolves true when there is nothing to wait for", async function () {
      expect(await adapt_taskutil.waitForFetchers([])).toBe(true);
    });

    it("waits until all the fetchers have arrived", async function () {
      var make = function (ms) {
        return new adapt_taskutil.Fetcher(async function () {
          await adapt_taskutil.sleep(ms);
          return ms;
        });
      };
      var fetchers = [make(15), make(5)];
      expect(await adapt_taskutil.waitForFetchers(fetchers)).toBe(true);
      expect(fetchers.map((f) => f.hasArrived())).toEqual([true, true]);
    });
  });
});
