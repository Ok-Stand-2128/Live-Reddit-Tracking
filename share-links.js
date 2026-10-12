(function () {
  "use strict";

  const FEEDBACK_DURATION_MS = 1800;
  const HIGHLIGHT_DURATION_MS = 2400;
  let requestedCardWasFocused = false;
  let tooltipNumber = 0;

  function getRequestedCardId() {
    return new URL(window.location.href)
      .searchParams
      .get("card");
  }

  function buildCardUrl(cardId, state) {
    const url = new URL(window.location.href);

    url.hash = "";
    ["card", "top", "ranks", "subreddit"].forEach(parameter => {
      url.searchParams.delete(parameter);
    });

    url.searchParams.set("card", cardId);

    Object.entries(state || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    return url.toString();
  }

  function fallbackCopy(text) {
    const textArea = document.createElement("textarea");

    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();

    const copied = document.execCommand("copy");
    textArea.remove();

    if (!copied) {
      throw new Error("The link could not be copied.");
    }
  }

  async function copyText(text) {
    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // Some browsers expose the API but deny clipboard access.
        console.warn(
          "Clipboard API unavailable; using the copy fallback.",
          error
        );
      }
    }

    fallbackCopy(text);
  }

  function trackShareClick(options, state, result) {
    if (
      !window.umami ||
      typeof window.umami.track !== "function"
    ) {
      return;
    }

    const currentPage = window.location.pathname
      .split("/")
      .pop()
      .toLowerCase();
    const card = options.analyticsCardId || options.cardId;
    const eventData = {
      page: currentPage === "comparison.html"
        ? "comparison"
        : "tracking",
      card,
      result
    };
    const subreddit = options.analyticsSubreddit ||
      (state && state.subreddit);

    if (subreddit) {
      eventData.subreddit = subreddit;
    }

    if (
      card === "top-x" &&
      state &&
      state.top
    ) {
      eventData.top_x = Number(state.top);
    }

    try {
      const trackingRequest = window.umami.track(
        "Card Share Click",
        eventData
      );

      if (
        trackingRequest &&
        typeof trackingRequest.catch === "function"
      ) {
        trackingRequest.catch(error => {
          console.warn(
            "Share analytics could not be recorded.",
            error
          );
        });
      }
    } catch (error) {
      console.warn(
        "Share analytics could not be recorded.",
        error
      );
    }
  }

  function setButtonMessage(button, message, isError) {
    const tooltip = button.nextElementSibling;
    const originalTooltip = button.dataset.originalTooltip;

    if (
      tooltip &&
      tooltip.classList.contains("copy-share-tooltip")
    ) {
      tooltip.textContent = message;
    }
    button.classList.toggle("copy-share-link-error", isError);

    window.clearTimeout(Number(button.dataset.feedbackTimer));
    const timer = window.setTimeout(() => {
      if (
        tooltip &&
        tooltip.classList.contains("copy-share-tooltip")
      ) {
        tooltip.textContent = originalTooltip;
      }
      button.classList.remove("copy-share-link-error");
    }, FEEDBACK_DURATION_MS);

    button.dataset.feedbackTimer = String(timer);
  }

  function addCopyLink(card, options) {
    if (!card || card.querySelector(":scope > .copy-share-link")) {
      return;
    }

    const button = document.createElement("button");
    const tooltip = document.createElement("span");
    const tooltipId = `copy-share-tooltip-${++tooltipNumber}`;

    card.classList.add("shareable-card");
    card.dataset.shareCard = options.cardId;

    button.type = "button";
    button.className = "copy-share-link";
    button.dataset.originalTooltip = "Copy link to share";
    button.setAttribute(
      "aria-label",
      options.accessibleLabel || `Copy link to ${options.cardTitle || "this card"}`
    );
    button.setAttribute("aria-describedby", tooltipId);
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M10.6 13.4a4 4 0 0 0 5.7 0l2.1-2.1a4 4 0 0 0-5.7-5.7l-1.2 1.2"/>' +
      '<path d="M13.4 10.6a4 4 0 0 0-5.7 0l-2.1 2.1a4 4 0 0 0 5.7 5.7l1.2-1.2"/>' +
      '</svg>';

    tooltip.id = tooltipId;
    tooltip.className = "copy-share-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = "Copy link to share";

    button.addEventListener("click", async () => {
      const state = typeof options.getState === "function"
        ? options.getState()
        : options.state;
      const url = buildCardUrl(options.cardId, state);

      try {
        await copyText(url);
        trackShareClick(options, state, "copied");
        setButtonMessage(button, "Copied!", false);
      } catch (error) {
        console.error(error);
        trackShareClick(options, state, "failed");
        setButtonMessage(button, "Copy failed", true);
      }
    });

    card.append(button, tooltip);
  }

  function findRequestedCard() {
    const requestedCardId = getRequestedCardId();

    if (!requestedCardId) {
      return null;
    }

    return Array.from(
      document.querySelectorAll("[data-share-card]")
    ).find(card => card.dataset.shareCard === requestedCardId) || null;
  }

  function focusRequestedCard() {
    if (requestedCardWasFocused) {
      return;
    }

    const card = findRequestedCard();

    if (!card) {
      return;
    }

    requestedCardWasFocused = true;

    window.requestAnimationFrame(() => {
      card.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center"
      });
      card.classList.add("shared-card-highlight");

      window.setTimeout(() => {
        card.classList.remove("shared-card-highlight");
      }, HIGHLIGHT_DURATION_MS);
    });
  }

  window.CardSharing = {
    addCopyLink,
    focusRequestedCard,
    getRequestedCardId
  };
})();
