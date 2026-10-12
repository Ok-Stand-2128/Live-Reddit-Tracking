// Global color palette
const COLORS = {
  TOP1: "rgb(104,150,54)",     // green
  TOP2: "rgb(247,196,31)",     // yellow
  TOP3: "rgb(231,84,84)",      // red
  OTHERS: "rgb(200,180,218)"   // purple
};

function parseCSV(csv) {
  return Papa.parse(csv, {
    header: true,
    skipEmptyLines: true
  }).data;
}

function getTimeWindowUTC() {
  const now = new Date();

  // Start of today's UTC calendar date.
  const todayUTC = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    )
  );

  // Select the latest complete UTC date that may be reported.
  const reportingDate = new Date(todayUTC);
  reportingDate.setUTCDate(
    reportingDate.getUTCDate() -
    REPORTING_LAG_DAYS
  );

  // Include that entire UTC date in the reporting window.
  const end = new Date(reportingDate);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCMilliseconds(-1);

  // Include exactly the configured number of UTC calendar dates.
  const start = new Date(reportingDate);
  start.setUTCDate(
    start.getUTCDate() -
    DASHBOARD_CONFIG.analysisWindowDays +
    1
  );

  return { start, end };
}

function convertUTCtoEST(utcString) {
  if (!utcString) return null;

  const utcDate = new Date(utcString);

  if (isNaN(utcDate)) return null;

  return new Date(
    utcDate.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

function countPostsInAnalysisWindow(data) {
  const { start, end } = getTimeWindowUTC();

  let count = 0;

  data.forEach(row => {
    if (!row.PostTimeUTC) return;

    const postDate = new Date(row.PostTimeUTC);

    if (isNaN(postDate)) return;

    if (postDate >= start && postDate <= end) {
      count++;
    }
  });

  return count;
}

const subredditSelect =
  document.getElementById("subreddit-select");

const subredditButtons = Array.from(
  subredditSelect.querySelectorAll(
    ".subreddit-option"
  )
).sort((first, second) =>
  first.textContent.trim().localeCompare(
    second.textContent.trim(),
    undefined,
    { sensitivity: "base" }
  )
);

subredditButtons.forEach(button => {
  subredditSelect.appendChild(button);
});

const csvDataPromises = new Map();
let topThreeRankingsPromise = null;
let currentCsvFilename = null;

function getSelectedSubredditName() {
  if (!currentCsvFilename) {
    return "";
  }

  return currentCsvFilename
    .replace("auth_reddit_", "")
    .replace(".csv", "");
}

function initializeTrackingSharing() {
  const shareableCards = [
    {
      elementId: "top-10-users-card",
      cardId: "top-10",
      title: "Top 10 Users"
    },
    {
      elementId: "top-3-users-card",
      cardId: "top-three",
      title: "Top 3 Users"
    },
    {
      elementId: "running-average-card",
      cardId: "running-average",
      title: "7-Day Running Daily Post Average"
    },
    {
      elementId: "daily-post-count-card",
      cardId: "daily-post-count",
      title: "Daily Post Count"
    },
    {
      elementId: "daily-percent-card",
      cardId: "daily-percent",
      title: "Daily Percent"
    },
    {
      elementId: "clustered-posting-card",
      cardId: "clustered-posting",
      title: "Clustered Posting"
    }
  ];

  shareableCards.forEach(card => {
    CardSharing.addCopyLink(
      document.getElementById(card.elementId),
      {
        cardId: card.cardId,
        cardTitle: card.title,
        getState: () => ({
          subreddit: getSelectedSubredditName()
        })
      }
    );
  });
}

function fetchCSVData(csvFilename) {
  if (!csvDataPromises.has(csvFilename)) {
    const dataPromise =
      fetch(`data/${csvFilename}`, {
        cache: "no-store"
      })
        .then(response => {
          if (!response.ok) {
            throw new Error(
              `Unable to load ${csvFilename}: ` +
              `HTTP ${response.status}`
            );
          }

          return response.text();
        })
        .then(csv => parseCSV(csv));

    csvDataPromises.set(
      csvFilename,
      dataPromise
    );
  }

  return csvDataPromises.get(csvFilename);
}

function calculateTopThreePercentage(data) {
  const filtered = getFilteredData(data);
  const counts = getUserCounts(filtered);

  const topThreePosts =
    Object.values(counts)
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce(
        (sum, count) => sum + count,
        0
      );

  return filtered.length > 0
    ? (topThreePosts / filtered.length) * 100
    : 0;
}

function getTopThreeRankings() {
  if (!topThreeRankingsPromise) {
    topThreeRankingsPromise = Promise.all(
      subredditButtons.map(button => {
        const csvFilename =
          button.dataset.filename;

        return fetchCSVData(csvFilename)
          .then(data => ({
            csvFilename,
            percentage:
              calculateTopThreePercentage(data)
          }));
      })
    ).then(results => {
      results.sort(
        (a, b) =>
          b.percentage - a.percentage
      );

      return new Map(
        results.map((result, index) => [
          result.csvFilename,
          index + 1
        ])
      );
    });
  }

  return topThreeRankingsPromise;
}

function updateSelectedTopThreeRank(
  csvFilename
) {
  const rankElement =
    document.getElementById(
      "selected-pie-rank"
    );

  rankElement.textContent = "";

  getTopThreeRankings()
    .then(rankings => {
      if (csvFilename !== currentCsvFilename) {
        return;
      }

      const rank =
        rankings.get(csvFilename);

      rankElement.textContent =
        rank
          ? `#${rank} of ${rankings.size}`
          : "";
    })
    .catch(error => {
      console.error(error);

      if (csvFilename === currentCsvFilename) {
        rankElement.textContent = "";
      }
    });
}

function loadDashboard(csvFilename) {
  currentCsvFilename = csvFilename;

  fetchCSVData(csvFilename)
    .then(data => {
      renderDashboard(
        data,
        csvFilename
      );
    })
    .catch(error => {
      console.error(error);

      document.getElementById(
        "total-posts"
      ).innerText = "Data unavailable";
    });
}

function renderDashboard(
  data,
  csvFilename
) {
  // Total posts
  const total = countPostsInAnalysisWindow(data);

  document.getElementById(
    "total-posts"
  ).innerText = total.toLocaleString();

  // Top-three pie chart
  const filtered = getFilteredData(data);
  const counts = getUserCounts(filtered);
  const { labels, values } =
    getTopUsers(counts);

  const subredditName =
    csvFilename
      .replace("auth_reddit_", "")
      .replace(".csv", "");

  const topThreePosts =
    Object.values(counts)
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce(
        (sum, count) => sum + count,
        0
      );

  const topThreePercentage =
    filtered.length > 0
      ? (
          topThreePosts /
          filtered.length
        ) * 100
      : 0;

  document.querySelectorAll(
    ".selected-subreddit-name"
  ).forEach(element => {
    element.textContent =
      `r/${subredditName}`;
  });

  document.getElementById(
    "selected-pie-total"
  ).textContent =
    `${topThreePercentage.toFixed(2)}% ` +
    `of the most recent ` +
    `${filtered.length.toLocaleString()} posts`;

  updateSelectedTopThreeRank(
    csvFilename
  );

  renderPieChart(labels, values);

  // Top-ten posters
  const top10 = getTop10Users(counts);

  renderTop10Chart(top10);

  // Seven-day running average
  const { end } =
    getTimeWindowUTC();

  const dates =
    getDateRange(
      end,
      DASHBOARD_CONFIG.analysisWindowDays
    );

  const dailyCounts =
    getDailyUserCounts(filtered, top10);

  const series =
    buildUserSeries(
      dates,
      dailyCounts,
      top10
    );

  renderRunningAvgChart(
    dates,
    series,
    top10
  );

  // Clustered posting
  const postsByUser =
    getPostsByUser(
      filtered,
      top10
    );

  const episodes =
    computeClusterEpisodes(postsByUser);

  const buckets =
    bucketClusterEpisodes(episodes);

  renderClusterChart(buckets);

  // Daily stacked charts
  const top3Users = top10
    .slice(0, 3)
    .map(([username]) => username);

  const daily = buildDailyCounts(
    data,
    top3Users
  );

  const stackedDates =
    fillMissingDates(daily);

  renderStackedChart(
    stackedDates,
    daily,
    top3Users
  );

  renderStackedPercentChart(
    stackedDates,
    daily,
    top3Users
  );

  CardSharing.focusRequestedCard();
}

subredditSelect.addEventListener(
  "click",
  event => {
    const button = event.target.closest(
      ".subreddit-option"
    );

    if (!button) return;

    // Record only deliberate visitor selections. The page also
    // programmatically clicks a random subreddit during startup.
    if (
      event.isTrusted &&
      typeof window.umami !== "undefined"
    ) {
      window.umami.track(
        "Subreddit Selection",
        {
          subreddit: button.textContent.trim()
        }
      );
    }

    subredditButtons.forEach(option => {
      const isSelected = option === button;

      option.classList.toggle(
        "active",
        isSelected
      );

      option.setAttribute(
        "aria-pressed",
        isSelected.toString()
      );
    });

    loadDashboard(button.dataset.filename);
  }
);

initializeTrackingSharing();

// Restore a shared subreddit, or select a random one for an ordinary visit.
const requestedSubreddit = new URL(window.location.href)
  .searchParams
  .get("subreddit");
const requestedSubredditButton = requestedSubreddit
  ? subredditButtons.find(button => {
      const buttonSubreddit = button.dataset.filename
        .replace("auth_reddit_", "")
        .replace(".csv", "");

      return buttonSubreddit.toLowerCase() ===
        requestedSubreddit.toLowerCase();
    })
  : null;

const initialSubredditButton = requestedSubredditButton ||
  subredditButtons[
    Math.floor(Math.random() * subredditButtons.length)
  ];

initialSubredditButton.click();


  
  /* Pie Chart Card */
function getFilteredData(data) {
  const { start, end } = getTimeWindowUTC();

  return data.filter(row => {
    if (!row.PostTimeUTC) return false;

    const d = new Date(row.PostTimeUTC);
    if (isNaN(d)) return false;

    return d >= start && d <= end;
  });
}

function getUserCounts(filteredData) {
  const counts = {};

  filteredData.forEach(row => {
    const user = row.Username || "Unknown";

    if (!counts[user]) counts[user] = 0;
    counts[user]++;
  });

  return counts;
}

function getTopUsers(counts) {
  const entries = Object.entries(counts);

  // sort descending
  entries.sort((a, b) => b[1] - a[1]);

  const top3 = entries.slice(0, 3);

  const othersTotal = entries.slice(3)
    .reduce((sum, [, count]) => sum + count, 0);

  const labels = top3.map(([user]) => user);
  const values = top3.map(([, count]) => count);

  if (othersTotal > 0) {
    labels.push("All Others");
    values.push(othersTotal);
  }

  return { labels, values };
}

function renderPieChart(labels, values) {
  // Build color array dynamically
  const colors = [];

  for (let i = 0; i < labels.length; i++) {
    if (i === 0) colors.push(COLORS.TOP1);
    else if (i === 1) colors.push(COLORS.TOP2);
    else if (i === 2) colors.push(COLORS.TOP3);
    else colors.push(COLORS.OTHERS);
  }

  const data = [{
    type: "pie",
    labels: labels,
    values: values,
    hole: 0.3,
    textinfo: "label+percent",
    textposition: "inside",
    textfont: {
      color: "#ffffff",
      size: 14
    },
    marker: {
      colors: colors
    },

    domain: { x: [0, 1], y: [0, 1] }
  }];

  const layout = {
    margin: { t: 10, b: 50, l: 0, r: 0 },

    legend: {
      orientation: "h",
      x: 0.5,
      xanchor: "center",
      y: -0.15
    }
  };

  Plotly.newPlot("pie-chart", data, layout);
}

/* Top Ten Users */
function getTop10Users(counts) {
  const entries = Object.entries(counts);

  // sort descending
  entries.sort((a, b) => b[1] - a[1]);

  return entries.slice(0, 10);
}

function getTop10Colors(top10) {
  return top10.map((_, i) => {
    if (i === 0) return COLORS.TOP1;
    if (i === 1) return COLORS.TOP2;
    if (i === 2) return COLORS.TOP3;
    return COLORS.OTHERS;
  });
}

function renderTop10Chart(top10) {
  const usernames = top10.map(([user]) => user);
  const counts = top10.map(([, count]) => count);

  const colors = getTop10Colors(top10);

  const data = [{
    type: "bar",
    orientation: "h",

    y: usernames,
    x: counts,

    marker: {
      color: colors
    },

    text: counts.map(v => v.toLocaleString()),
    textposition: "outside"
  }];

  const layout = {
    margin: { t: 10, b: 40, l: 150, r: 20 },

    xaxis: {
      title: "Post Count",
      range: [0, Math.max(...counts) * 1.05]
    },

    yaxis: {
      autorange: "reversed",
      showline: true,
      linecolor: "#a2aab1",
      linewidth: 1
    }
  };

  Plotly.newPlot("top10-chart", data, layout);
}

/* 7-day running average of top ten users */
function getDailyUserCounts(filteredData, top10Users) {
  const counts = {};

  const topSet = new Set(top10Users.map(([u]) => u));

  filteredData.forEach(row => {
    const user = row.Username;
    if (!topSet.has(user)) return;

    const date = new Date(row.PostTimeUTC)
      .toISOString()
      .split("T")[0];

    if (!counts[date]) counts[date] = {};
    if (!counts[date][user]) counts[date][user] = 0;

    counts[date][user]++;
  });

  return counts;
}

function getDateRange(end, numberOfDays) {
  const dates = [];
  const current = new Date(end);

  current.setUTCHours(0, 0, 0, 0);
  current.setUTCDate(
    current.getUTCDate() - numberOfDays + 1
  );

  for (let day = 0; day < numberOfDays; day++) {
    dates.push(current.toISOString().split("T")[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function getEndAnchoredWeeklyTicks(dates) {
  if (!Array.isArray(dates) || dates.length === 0) {
    return [];
  }

  const firstDate = new Date(`${dates[0]}T00:00:00Z`);
  const lastDate = new Date(
    `${dates[dates.length - 1]}T00:00:00Z`
  );
  const ticks = [];
  let current = new Date(lastDate);

  while (current >= firstDate) {
    ticks.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() - 7);
  }

  const firstDateKey = firstDate.toISOString().slice(0, 10);

  if (!ticks.includes(firstDateKey)) {
    ticks.push(firstDateKey);
  }

  return ticks.sort();
}

function buildUserSeries(dates, dailyCounts, top10Users) {
  const series = {};

  top10Users.forEach(([user]) => {
    series[user] = dates.map(date =>
      (dailyCounts[date] && dailyCounts[date][user]) || 0
    );
  });

  return series;
}

function movingAverage(arr, window = 7) {
  const result = [];

  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - window + 1);
    const subset = arr.slice(start, i + 1);

    const avg =
      subset.reduce((sum, v) => sum + v, 0) / subset.length;

    result.push(avg);
  }

  return result;
}

function getLineColor(user, index) {
  if (index === 0) return COLORS.TOP1;
  if (index === 1) return COLORS.TOP2;
  if (index === 2) return COLORS.TOP3;
  return COLORS.OTHERS;
}

function renderRunningAvgChart(dates, series, top10Users) {
  const traces = [];

  top10Users.forEach(([user], i) => {
    const avg = movingAverage(series[user]);

    traces.push({
      type: "scatter",
      mode: "lines",

      name: user,
      x: dates,
      y: avg,

      line: {
        color: getLineColor(user, i),
        width: i < 3 ? 3 : 1.5
      }
    });
  });

  const layout = {
    margin: { t: 20, b: 40, l: 60, r: 20 },

    xaxis: {
      title: "Date",
      type: "date",
      tickmode: "array",
      tickvals: getEndAnchoredWeeklyTicks(dates),
      tickformat: "%b %d",
      tickangle: -45
    },

    yaxis: {
      title: "7-day avg"
    },

    autosize: true
  };

  Plotly.newPlot("running-avg-chart", traces, layout);
}

/* Clustered posting */
function getPostsByUser(filteredData, top10Users) {
  const topSet = new Set(top10Users.map(([u]) => u));

  const postsByUser = {};

  filteredData.forEach(row => {
    const user = row.Username;
    if (!topSet.has(user)) return;

    if (!postsByUser[user]) postsByUser[user] = [];
    postsByUser[user].push(new Date(row.PostTimeUTC));
  });

  // Include every post within the configured analysis window.
  Object.keys(postsByUser).forEach(user => {
    postsByUser[user].sort((a, b) => a - b);
  });

  return postsByUser;
}

function computeClusterEpisodes(postsByUser) {
  const episodes = {};

  Object.entries(postsByUser).forEach(([user, posts]) => {
    const sorted = [...posts].sort((a, b) => a - b);

    episodes[user] = [];

    let i = 0;

    while (i < sorted.length - 2) {
      const diffSeconds =
        (sorted[i + 2] - sorted[i]) / 1000;

      /*
       * A qualifying group consumes all three posts so
       * no post can contribute to another cluster. When
       * the group does not qualify, discard only its
       * oldest post and evaluate the next three posts.
       */
      if (diffSeconds <= 1200) {
        episodes[user].push(diffSeconds);
        i += 3;
      } else {
        i += 1;
      }
    }
  });

  return episodes;
}

function bucketClusterEpisodes(episodes) {
  const buckets = {};

  Object.entries(episodes).forEach(([user, values]) => {
    buckets[user] = {
      "0-5 min": 0,
      "5-10 min": 0,
      "10-15 min": 0,
      "15-20 min": 0
    };

    values.forEach(sec => {
      if (sec <= 300) buckets[user]["0-5 min"]++;
      else if (sec <= 600) buckets[user]["5-10 min"]++;
      else if (sec <= 900) buckets[user]["10-15 min"]++;
      else if (sec <= 1200) buckets[user]["15-20 min"]++;
    });
  });

  return buckets;
}

function sortUsersByCluster(buckets) {
  return Object.keys(buckets).sort((a, b) =>
    (buckets[b]["0-5 min"] || 0) - (buckets[a]["0-5 min"] || 0)
  );
}

const BUCKET_COLORS = {
  "0-5 min": "rgb(160,120,200)",
  "5-10 min": "rgb(104,150,54)",
  "10-15 min": "rgb(247,196,31)",
  "15-20 min": "rgb(100,100,160)"
};

function renderClusterChart(buckets) {
  const users = sortUsersByCluster(buckets);

  const bucketNames = [
    "0-5 min",
    "5-10 min",
    "10-15 min",
    "15-20 min"
  ];

  const traces = bucketNames.map(bucket => ({
    type: "scatter",

    // 👇 key change: line only for 0-5
    mode: bucket === "0-5 min" ? "lines+markers" : "markers",

    name: bucket,

    x: users,
    y: users.map(u => buckets[u][bucket] || 0),

    marker: {
      size: bucket === "0-5 min" ? 12 : 9,   // 👈 subtle emphasis
      color: BUCKET_COLORS[bucket],
      opacity: 0.8                          // 👈 overlap fix
    },

    // 👇 only applies to 0-5
    line: bucket === "0-5 min" ? {
      color: BUCKET_COLORS[bucket],
      width: 1,
      opacity: 0.8,
    } : undefined
  }));

  const layout = {
    margin: { t: 20, b: 100, l: 60, r: 20 },

    xaxis: {
      title: "",
      tickangle: -30,
      automargin: true   // 👈 prevents label clipping
    },

    yaxis: {
      title: "Clustered-Posting Occurrences"
    },

    legend: {
      title: {
        text: "Cluster Bins"
      }
    }
  };

  Plotly.newPlot("cluster-chart", traces, layout, {
    responsive: true
  });
}

function createEmptyDailyCounts() {
  return {
    Top1: 0,
    Top2: 0,
    Top3: 0,
    Others: 0
  };
}

function buildDailyCounts(data, top3Users) {
  const { start, end } = getTimeWindowUTC();

  const daily = {};

  data.forEach(row => {
    const user =
      row.Username || "Unknown";

    const postDate =
      new Date(row.PostTimeUTC);

    if (isNaN(postDate)) return;

    if (
      postDate < start ||
      postDate > end
    ) {
      return;
    }

    const date = postDate
      .toISOString()
      .split("T")[0];

    if (!daily[date]) {
      daily[date] =
        createEmptyDailyCounts();
    }

    if (user === top3Users[0]) {
      daily[date].Top1++;
    } else if (user === top3Users[1]) {
      daily[date].Top2++;
    } else if (user === top3Users[2]) {
      daily[date].Top3++;
    } else {
      daily[date].Others++;
    }
  });

  return daily;
}

function fillMissingDates(daily) {
  const { start, end } = getTimeWindowUTC();
  const dates = [];

  let current = new Date(start);

  while (current <= end) {
    const date = current
      .toISOString()
      .split("T")[0];

    if (!daily[date]) {
      daily[date] =
        createEmptyDailyCounts();
    }

    dates.push(date);

    current.setUTCDate(
      current.getUTCDate() + 1
    );
  }

  return dates.sort();
}

function renderStackedChart(
  dates,
  daily,
  top3Users
) {
  const top1 = dates.map(
    date => daily[date].Top1
  );

  const top2 = dates.map(
    date => daily[date].Top2
  );

  const top3 = dates.map(
    date => daily[date].Top3
  );

  const others = dates.map(
    date => daily[date].Others
  );

  const top1Name =
    top3Users[0] || "Top User 1";

  const top2Name =
    top3Users[1] || "Top User 2";

  const top3Name =
    top3Users[2] || "Top User 3";

  const traces = [
    {
      type: "bar",
      name: top1Name,
      x: dates,
      y: top1,
      marker: {
        color: COLORS.TOP1
      }
    },
    {
      type: "bar",
      name: top2Name,
      x: dates,
      y: top2,
      marker: {
        color: COLORS.TOP2
      }
    },
    {
      type: "bar",
      name: top3Name,
      x: dates,
      y: top3,
      marker: {
        color: COLORS.TOP3
      }
    },
    {
      type: "bar",
      name: "All Others",
      x: dates,
      y: others,
      marker: {
        color: COLORS.OTHERS
      }
    }
  ];

  const layout = {
    barmode: "stack",

    margin: {
      t: 20,
      b: 60,
      l: 60,
      r: 20
    },

    xaxis: {
      title: "Date",
      type: "date",
      tickmode: "array",
      tickvals: getEndAnchoredWeeklyTicks(dates),
      tickformat: "%b %d",
      tickangle: -45
    },

    yaxis: {
      title: "Post Count"
    },

    hovermode: "x unified"
  };

  Plotly.newPlot(
    "stacked-chart",
    traces,
    layout,
    {
      responsive: true
    }
  );
}

/* Percentages of daily posts stacked bar chart*/
function convertToPercent(
  dates,
  daily
) {
  const top1 = [];
  const top2 = [];
  const top3 = [];
  const others = [];

  dates.forEach(date => {
    const day =
      daily[date] ||
      createEmptyDailyCounts();

    const first = day.Top1 || 0;
    const second = day.Top2 || 0;
    const third = day.Top3 || 0;
    const remaining = day.Others || 0;

    const total =
      first +
      second +
      third +
      remaining;

    if (total === 0) {
      top1.push(0);
      top2.push(0);
      top3.push(0);
      others.push(0);
    } else {
      top1.push(
        (first / total) * 100
      );

      top2.push(
        (second / total) * 100
      );

      top3.push(
        (third / total) * 100
      );

      others.push(
        (remaining / total) * 100
      );
    }
  });

  return {
    top1,
    top2,
    top3,
    others
  };
}

function renderStackedPercentChart(
  dates,
  daily,
  top3Users
) {
  const {
    top1,
    top2,
    top3,
    others
  } = convertToPercent(
    dates,
    daily
  );

  const top1Name =
    top3Users[0] || "Top User 1";

  const top2Name =
    top3Users[1] || "Top User 2";

  const top3Name =
    top3Users[2] || "Top User 3";

  const traces = [
    {
      type: "bar",
      name: `${top1Name} %`,
      x: dates,
      y: top1,
      marker: {
        color: COLORS.TOP1
      }
    },
    {
      type: "bar",
      name: `${top2Name} %`,
      x: dates,
      y: top2,
      marker: {
        color: COLORS.TOP2
      }
    },
    {
      type: "bar",
      name: `${top3Name} %`,
      x: dates,
      y: top3,
      marker: {
        color: COLORS.TOP3
      }
    },
    {
      type: "bar",
      name: "All Others %",
      x: dates,
      y: others,
      marker: {
        color: COLORS.OTHERS
      }
    }
  ];

  const referencePercentages = [25, 50, 75];
  const shapes = [];

  referencePercentages.forEach(y => {
    shapes.push({
      type: "line",
      xref: "paper",
      yref: "y",
      x0: 0,
      x1: 1,
      y0: y,
      y1: y,

      line: {
        color: "rgba(0,0,0,1)",
        width: 1,
        dash: "longdash"
      }
    });
  });

  const annotations = referencePercentages.map(y => ({
    xref: "paper",
    yref: "y",
    x: 0.99,
    y: y,
    text: `${y}%`,
    showarrow: false,
    xanchor: "right",
    yanchor: "bottom",
    font: {
      size: 12,
      color: "rgb(60, 60, 60)"
    },
    bgcolor: "rgba(255, 255, 255, 0.85)",
    borderpad: 2
  }));

  const layout = {
    barmode: "stack",

    margin: {
      t: 20,
      b: 60,
      l: 60,
      r: 20
    },

    xaxis: {
      title: "Date",
      type: "date",
      tickmode: "array",
      tickvals: getEndAnchoredWeeklyTicks(dates),
      tickformat: "%b %d",
      tickangle: -45
    },

    yaxis: {
      title: "Percent",
      range: [0, 100]
    },

    hovermode: "x unified",

    shapes: shapes,
    annotations: annotations
  };

  Plotly.newPlot(
    "stacked-percent-chart",
    traces,
    layout,
    {
      responsive: true
    }
  );
}
