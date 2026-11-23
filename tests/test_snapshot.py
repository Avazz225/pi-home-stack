"""The shared device reading.

Worth its own file because the thing it has to get right only happens under
concurrency: several requests arriving while one slow device call is already in
flight. That is the case that produced Bad Gateway in the dashboard, and it is
invisible in a single-threaded test.
"""

import importlib.util
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.join(HERE, "..", "apps", "home")
sys.path.insert(0, HOME)

failed = 0


def check(label, got, want):
    global failed
    if got == want:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}\n        expected: {want!r}\n        got:      {got!r}")
        failed = 1


def ok(label, condition, detail=""):
    check(label, bool(condition) or detail, True)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HOME, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


snapshot = load("snapshot")


class Fake:
    """A device that can be told how slowly to answer, and how to fail."""

    def __init__(self, value="A", delay=0.0):
        self.value = value
        self.delay = delay
        self.error = None
        self.calls = 0
        self._lock = threading.Lock()

    def read(self):
        with self._lock:
            self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        if self.error:
            raise RuntimeError(self.error)
        return self.value


class Hand:
    """A clock the test winds, so no test has to wait out a TTL."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


# ── One reading per interval ──────────────────────────────────────────────────

clock = Hand()
device = Fake("A")
shared = snapshot.Shared(ttl=10, grace=180, clock=clock)

check("the first ask reads the device", shared.get("dev", device.read)[0], "A")
check("and the device was asked once", device.calls, 1)

for _ in range(20):
    shared.get("dev", device.read)
check("twenty more asks inside the interval read nothing",
      device.calls, 1)

clock.advance(11)
device.value = "B"
check("past the interval, the device is read again",
      shared.get("dev", device.read)[0], "B")
check("once", device.calls, 2)

# A gateway at a different address is a different device. Serving the old
# reading for it would be the wrong answer, not a stale one.
check("changing what is asked about discards the reading",
      shared.get("other", device.read)[0], "B")
check("and reads straight away", device.calls, 3)

# ── Several askers, one slow device ───────────────────────────────────────────
#
# This is the case the class exists for. The overview is polled every fifteen
# seconds, a second browser tab doubles that, and the sampler joins in - each of
# them used to start its own fan-out of six or seven calls at a small gateway.

device = Fake("S", delay=0.4)
shared = snapshot.Shared(ttl=10, grace=180)
answers = []
barrier = threading.Barrier(6)


def asker():
    barrier.wait()
    answers.append(shared.get("dev", device.read)[0])


threads = [threading.Thread(target=asker) for _ in range(6)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()

check("six at once all get an answer", len(answers), 6)
check("and all the same one", set(answers), {"S"})
check("the device was asked exactly once", device.calls, 1)
ok("which is what it was fetched as", shared.fetches == 1, shared.fetches)

# ── When the device stops answering ───────────────────────────────────────────

clock = Hand()
device = Fake("good")
shared = snapshot.Shared(ttl=10, grace=180, clock=clock)
shared.get("dev", device.read)

clock.advance(20)
device.error = "Gateway nicht erreichbar"
value, error, age = shared.get("dev", device.read)
check("a failed read still hands back the last good value", value, "good")
check("together with the reason", error, "Gateway nicht erreichbar")
check("and how old it is", age, 20)

# Three minutes is the limit. A reading older than that is not a stale view of
# the present, it is history, and showing it as the room's temperature would be
# worse than showing nothing.
clock.advance(200)
value, error, age = shared.get("dev", device.read)
check("past the grace period, nothing is served", value, None)
check("but the reason still is", error, "Gateway nicht erreichbar")
check("and no age is claimed", age, None)

device.error = None
device.value = "back"
check("a device that recovers is served again",
      shared.get("dev", device.read)[0], "back")
check("and the error is gone", shared.get("dev", device.read)[1], None)

# A device that has never answered has nothing to fall back on.
shared = snapshot.Shared()
broken = Fake()
broken.error = "nie erreichbar"
value, error, age = shared.get("dev", broken.read)
check("a device that never answered yields no value", value, None)
check("only the reason", error, "nie erreichbar")

# An exception with no message must still produce something readable: the UI
# prints this string, and an empty one reads as "it broke, no idea why".
class Silent(Exception):
    pass


def mute():
    raise Silent()


check("a wordless failure is named by its type",
      snapshot.Shared().get("dev", mute)[1], "Silent")

# ── After writing to the device ───────────────────────────────────────────────

clock = Hand()
device = Fake("old")
shared = snapshot.Shared(ttl=60, grace=180, clock=clock)
shared.get("dev", device.read)
device.value = "new"
check("inside the interval the old value stands",
      shared.get("dev", device.read)[0], "old")
shared.invalidate()
check("after a write it is read again", shared.get("dev", device.read)[0], "new")

# ── A device slower than the wait ─────────────────────────────────────────────
#
# The waiting asker must come back with something rather than hang: nginx gives
# up on a request long before a device that has stopped answering does.

device = Fake("slow", delay=1.2)
shared = snapshot.Shared(ttl=10, grace=180, wait=0.2)
first = []
thread = threading.Thread(target=lambda: first.append(shared.get("d", device.read)[0]))
thread.start()
time.sleep(0.1)
started = time.monotonic()
value, error, age = shared.get("d", device.read)
waited = time.monotonic() - started
ok("a second asker gives up on the wait rather than hanging", waited < 0.6, waited)
check("with nothing to show yet, and no invented error", (value, error), (None, None))
ok("and it did not start a second read of its own", device.calls == 1, device.calls)
thread.join()
check("while the first asker gets the real answer", first, ["slow"])

print()
print("Alle Snapshot-Tests bestanden." if not failed else "Fehler aufgetreten.")
sys.exit(failed)
