"""One reading of a device, shared by everybody who asks at about the same time.

The home service talks to two things that are slow and small: a BLU gateway and
a Hue bridge. Reading the gateway costs six or seven HTTP calls - the component
list, the gateway clock, and one cached status per valve - and each of them is
allowed eight seconds before it is given up on.

The dashboard polls the overview every fifteen seconds, the sampler asks every
five minutes, and a second browser tab doubles the first of those. Without
anything in between, each of those askers started its own fan-out, so an ESP32
that serves one connection at a time saw around twenty-five requests a minute
and several at once. What arrives at the browser when that goes wrong is a Bad
Gateway, which says nothing about a slow valve.

So: one reading per interval, and whoever asks during it waits for that reading
instead of starting another. If it cannot be had, the last good one is served
with its age attached, because a number from two minutes ago under a visible
warning is worth more than an error page. Nothing here retries - a device that
is not answering is not helped by being asked twice as often.
"""

from __future__ import annotations

import threading
import time

# How long a reading stays current. Longer than it takes to read the gateway and
# shorter than the dashboard's poll, so an idle dashboard gets a fresh reading
# every time and a busy one stops multiplying them.
TTL_S = 10

# How old a reading may be and still be served when the device has gone quiet.
# Three minutes: long enough to cover a reboot or a lost Bluetooth connection,
# short enough that nobody mistakes it for the present.
GRACE_S = 180

# How long to wait for somebody else's reading before giving up on it. A little
# longer than the whole fan-out normally takes.
WAIT_S = 12


class Shared:
    """A single cached reading, with one fetch at a time.

    `key` identifies what the reading is of - a gateway address, say. Changing
    it throws the reading away, because a reading of the old address is not a
    stale reading of the new one, it is the wrong answer.
    """

    def __init__(self, ttl=TTL_S, grace=GRACE_S, wait=WAIT_S, clock=time.monotonic):
        self.ttl = ttl
        self.grace = grace
        self.wait = wait
        self.clock = clock
        self._condition = threading.Condition()
        self._key = None
        self._value = None
        self._error = None
        self._at = None
        self._fetching = False
        # Counted so the tests, and anybody reading a log, can tell the
        # difference between "answered from the cache" and "did not ask".
        self.fetches = 0

    # ── What a caller gets ───────────────────────────────────────────────────

    def _age(self):
        return None if self._at is None else self.clock() - self._at

    def _answer(self):
        """The reading as it stands, and how old it is.

        The error is handed back alongside the value rather than instead of it:
        when the last attempt failed but a reading from a minute ago exists,
        the screen should show the numbers *and* say the gateway is not
        answering. Reporting only the error throws away what is known.
        """
        age = self._age()
        if self._value is not None and age is not None and age <= self.grace:
            return self._value, self._error, age
        return None, self._error, None

    def get(self, key, fetch):
        """The current reading of `key`, fetching it only if nobody else is.

        `fetch` is called without the lock held, so a slow device does not
        block the thread that is only reading the cache.
        """
        with self._condition:
            if key != self._key:
                self._key, self._value, self._error, self._at = key, None, None, None
            age = self._age()
            if age is not None and age < self.ttl:
                return self._answer()

            if self._fetching:
                # Somebody is already asking. Waiting for their answer is both
                # faster and kinder to the device than asking in parallel.
                self._condition.wait_for(lambda: not self._fetching, timeout=self.wait)
                # Whatever came of it - a fresh reading, an error, or nothing
                # because the wait ran out - is what this caller gets. Falling
                # through to our own attempt here would reintroduce exactly the
                # pile-up this class exists to prevent.
                return self._answer()

            self._fetching = True

        value, error = None, None
        try:
            value = fetch()
        except Exception as problem:                        # noqa: BLE001
            # Deliberately broad: whatever a client library raises, the service
            # has to go on answering. The message is passed through, and the
            # caller decides whether it belongs on screen.
            error = str(problem) or problem.__class__.__name__

        with self._condition:
            self.fetches += 1
            self._error = error
            if value is not None:
                self._value = value
                self._at = self.clock()
            self._fetching = False
            self._condition.notify_all()
            return self._answer()

    def invalidate(self):
        """Forget the reading, so the next caller fetches.

        Used after writing to a device: the setpoint just sent is the one thing
        the cached reading is certainly wrong about.
        """
        with self._condition:
            self._value, self._error, self._at = None, None, None
