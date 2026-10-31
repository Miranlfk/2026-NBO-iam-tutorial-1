// Clock, code countdown and polling. The server does every OAuth call; this
// script only asks it "anything yet?" at the interval the server returns.

(function () {
  const body = document.body;
  const clock = document.getElementById("clock");

  function tick() {
    if (clock) {
      clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  }

  tick();
  setInterval(tick, 15000);

  if (body.dataset.state !== "pending") {
    return;
  }

  const expiresAt = Number(body.dataset.expiresAt);
  const countdown = document.getElementById("countdown");
  const status = document.getElementById("status");
  const messages = {
    pending: "Waiting for you to approve on your phone…",
    slow_down: "Asked to slow down — checking a little less often…"
  };

  function updateCountdown() {
    const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);

    countdown.textContent = minutes + ":" + String(seconds % 60).padStart(2, "0");

    if (seconds === 0) {
      window.location.reload();
    }
  }

  async function poll() {
    let result = { status: "pending", retryAfter: Number(body.dataset.interval) || 5 };

    try {
      const response = await fetch("/poll", { method: "POST", headers: { Accept: "application/json" } });
      result = await response.json();
    } catch (error) {
      // Offline for a moment: try again at the same interval.
    }

    if (result.status === "pending" || result.status === "slow_down") {
      status.textContent = messages[result.status];
      setTimeout(poll, (result.retryAfter || 5) * 1000);
      return;
    }

    // approved, denied, expired or error: the server has the outcome ready.
    window.location.reload();
  }

  updateCountdown();
  setInterval(updateCountdown, 1000);
  setTimeout(poll, (Number(body.dataset.interval) || 5) * 1000);
})();
