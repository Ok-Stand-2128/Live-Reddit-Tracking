const REPORTING_LAG_DAYS = 5;

window.DASHBOARD_CONFIG = Object.freeze({
  analysisWindowDays: 60,
  analysisStartDateUTC: "2026-08-10T00:00:00Z"
});

document.addEventListener(
  "DOMContentLoaded",
  () => {
    document.querySelectorAll(
      ".analysis-window-days"
    ).forEach(element => {
      element.textContent =
        window.DASHBOARD_CONFIG
          .analysisWindowDays
          .toLocaleString();
    });

  }
);
