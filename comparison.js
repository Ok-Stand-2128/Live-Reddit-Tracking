const SUBREDDITS = [
  {
    name: "politics",
    filename: "auth_reddit_politics.csv"
  },
  {
    name: "conspiracy",
    filename: "auth_reddit_conspiracy.csv"
  },
  {
    name: "worldnews",
    filename: "auth_reddit_worldnews.csv"
  },
  {
    name: "Conservative",
    filename: "auth_reddit_Conservative.csv"
  },
  {
    name: "AnythingGoesNews",
    filename: "auth_reddit_AnythingGoesNews.csv"
  },
  {
    name: "ProgressiveHQ",
    filename: "auth_reddit_ProgressiveHQ.csv"
  },
  {
    name: "antitrump",
    filename: "auth_reddit_antitrump.csv"
  },
  {
    name: "ukpolitics",
    filename: "auth_reddit_ukpolitics.csv"
  },
  {
    name: "trump",
    filename: "auth_reddit_trump.csv"
  },
  {
    name: "neoliberal",
    filename: "auth_reddit_neoliberal.csv"
  },
  {
    name: "CanadaPolitics",
    filename: "auth_reddit_CanadaPolitics.csv"
  },
  {
    name: "socialism",
    filename: "auth_reddit_socialism.csv"
  },
  {
    name: "democrats",
    filename: "auth_reddit_democrats.csv"
  }
];

const POST_SHARE_THRESHOLDS = [
  0.10,
  0.20,
  0.30,
  0.40,
  0.50,
  0.60,
  0.70,
  0.80,
  0.90,
  1.0
];

const COLORS = {
  TOP1: "rgb(104,150,54)",
  TOP2: "rgb(247,196,31)",
  TOP3: "rgb(231,84,84)",
  OTHERS: "rgb(200,180,218)"
};

const DAILY_POST_LINE_COLORS = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#393b79",
  "#637939",
  "#8c6d31"
];

function parseCSV(csv) {
  return Papa.parse(csv, {
    header: true,
    skipEmptyLines: true
  }).data;
}

function getTimeWindowUTC() {
  const now = new Date();

  const todayUTC = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    )
  );

  const reportingDate =
    new Date(todayUTC);

  reportingDate.setUTCDate(
    reportingDate.getUTCDate() -
    REPORTING_LAG_DAYS
  );

  const end = new Date(reportingDate);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCMilliseconds(-1);

  const start =
    new Date(reportingDate);

  start.setUTCDate(
    start.getUTCDate() -
    DASHBOARD_CONFIG.analysisWindowDays +
    1
  );

  return {
    start,
    end
  };
}

function filterToTimeWindow(rows) {
  const { start, end } =
    getTimeWindowUTC();

  return rows.filter(row => {
    if (!row.PostTimeUTC) {
      return false;
    }

    const postDate =
      new Date(row.PostTimeUTC);

    if (isNaN(postDate)) {
      return false;
    }

    return (
      postDate >= start &&
      postDate <= end
    );
  });
}

function calculateTopPosterShare(
  rows,
  posterCount
) {
  const filteredRows =
    filterToTimeWindow(rows);

  const totalPosts =
    filteredRows.length;

  if (totalPosts === 0) {
    return {
      totalPosts: 0,
      topPosterPosts: 0,
      percentage: 0
    };
  }

  const userCounts = {};

  filteredRows.forEach(row => {
    const username =
      row.Username || "Unknown";

    if (!userCounts[username]) {
      userCounts[username] = 0;
    }

    userCounts[username]++;
  });

  const sortedCounts =
    Object.values(userCounts)
      .sort((a, b) => b - a);

  const topPosterPosts =
    sortedCounts
      .slice(0, posterCount)
      .reduce(
        (sum, count) => sum + count,
        0
      );

  const percentage =
    (topPosterPosts / totalPosts) * 100;

  return {
    totalPosts,
    topPosterPosts,
    percentage
  };
}

function calculateTopThreeShare(rows) {
  const filteredRows =
    filterToTimeWindow(rows);

  const totalPosts =
    filteredRows.length;

  const userCounts = {};

  filteredRows.forEach(row => {
    const username =
      row.Username || "Unknown";

    if (!userCounts[username]) {
      userCounts[username] = 0;
    }

    userCounts[username]++;
  });

  const sortedUsers =
    Object.entries(userCounts)
      .sort((a, b) => b[1] - a[1]);

  const topThree =
    sortedUsers.slice(0, 3);

  const topThreePosts =
    topThree.reduce(
      (sum, [, count]) => sum + count,
      0
    );

  const allOthersPosts =
    Math.max(
      0,
      totalPosts - topThreePosts
    );

  const combinedPercentage =
    totalPosts > 0
      ? (topThreePosts / totalPosts) * 100
      : 0;

  const labels =
    topThree.map(([username]) => username);

  const values =
    topThree.map(([, count]) => count);

  if (allOthersPosts > 0) {
    labels.push("All Others");
    values.push(allOthersPosts);
  }

  return {
    totalPosts,
    topThreePosts,
    combinedPercentage,
    labels,
    values
  };
}

function isUsableUsername(username) {
  if (typeof username !== "string") {
    return false;
  }

  const cleanedUsername =
    username.trim();

  if (!cleanedUsername) {
    return false;
  }

  return (
    cleanedUsername.toLowerCase() !==
    "[deleted]"
  );
}

function calculateWeeklyPostingRate(
  windowPosts
) {
  const activityWindowDays =
    DASHBOARD_CONFIG.analysisWindowDays;

  const estimatedWeeklyPosts =
    activityWindowDays > 0
      ? Math.round(
          (
            windowPosts.length /
            activityWindowDays
          ) * 7
        )
      : 0;

  return {
    estimatedWeeklyPosts,
    activitySamplePosts:
      windowPosts.length,
    activityWindowDays
  };
}

function calculatePosterThresholds(rows) {
  /*
   * First select posts in the configured
   * reporting window.
   * Then remove posts with blank or deleted
   * usernames from both the denominator and
   * poster counts.
   */
  const windowPosts =
    filterToTimeWindow(rows);

  const weeklyPostingRate =
    calculateWeeklyPostingRate(
      windowPosts
    );

  const usablePosts =
    windowPosts.filter(row =>
      isUsableUsername(row.Username)
    );

  const totalUsablePosts =
    usablePosts.length;

  if (totalUsablePosts === 0) {
    return {
      totalUsablePosts: 0,
      totalUniquePosters: 0,

      postersNeeded:
        POST_SHARE_THRESHOLDS.map(
          () => 0
        ),

      posterPercentages:
        POST_SHARE_THRESHOLDS.map(
          () => 0
        ),

      estimatedWeeklyPosts:
        weeklyPostingRate
          .estimatedWeeklyPosts,

      activitySamplePosts:
        weeklyPostingRate
          .activitySamplePosts,

      activityWindowDays:
        weeklyPostingRate
          .activityWindowDays
    };
  }

  const userCounts = new Map();

  usablePosts.forEach(row => {
    const username =
      row.Username.trim();

    const existingCount =
      userCounts.get(username) || 0;

    userCounts.set(
      username,
      existingCount + 1
    );
  });

  const sortedPosterCounts =
    Array.from(userCounts.values())
      .sort((a, b) => b - a);

  let cumulativePosts = 0;
  let postersUsed = 0;

  const postersNeeded =
    POST_SHARE_THRESHOLDS.map(
      threshold => {
        const targetPosts =
          Math.ceil(
            totalUsablePosts * threshold
          );

        while (
          postersUsed <
            sortedPosterCounts.length &&
          cumulativePosts < targetPosts
        ) {
          cumulativePosts +=
            sortedPosterCounts[
              postersUsed
            ];

          postersUsed++;
        }

        return postersUsed;
      }
    );

  const totalUniquePosters =
    userCounts.size;

  const posterPercentages =
    postersNeeded.map(
      posterCount => {
        return (
          posterCount /
          totalUniquePosters
        ) * 100;
      }
    );

  return {
    totalUsablePosts:
      totalUsablePosts,

    totalUniquePosters:
      totalUniquePosters,

    postersNeeded:
      postersNeeded,

    posterPercentages:
      posterPercentages,

    estimatedWeeklyPosts:
      weeklyPostingRate
        .estimatedWeeklyPosts,

    activitySamplePosts:
      weeklyPostingRate
        .activitySamplePosts,

    activityWindowDays:
      weeklyPostingRate
        .activityWindowDays
  };
}

async function loadSubredditData(subreddit) {
  const response = await fetch(
    `data/${subreddit.filename}`,
    {
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Unable to load ${subreddit.filename}: ` +
      `HTTP ${response.status}`
    );
  }

  const csv =
    await response.text();

  const rows =
    parseCSV(csv);

  const topThreeCalculation =
    calculateTopThreeShare(rows);

  const thresholdCalculation =
    calculatePosterThresholds(rows);

  return {
    subreddit: subreddit.name,
    rows,
    topThreeCalculation,
    thresholdCalculation
  };
}

function formatUTCDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function formatDateRangeLabel(dateKey) {
  return new Intl.DateTimeFormat(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    }
  ).format(
    new Date(`${dateKey}T00:00:00Z`)
  );
}

function getDateAxisRange(dateKeys) {
  if (dateKeys.length !== 1) {
    return [
      dateKeys[0],
      dateKeys[dateKeys.length - 1]
    ];
  }

  const selectedDate = new Date(
    `${dateKeys[0]}T00:00:00Z`
  );
  const halfDayMilliseconds =
    12 * 60 * 60 * 1000;

  return [
    new Date(
      selectedDate.getTime() -
      halfDayMilliseconds
    ).toISOString(),
    new Date(
      selectedDate.getTime() +
      halfDayMilliseconds
    ).toISOString()
  ];
}

function getEndAnchoredWeeklyTicks(dateKeys) {
  if (!Array.isArray(dateKeys) || dateKeys.length === 0) {
    return [];
  }

  const firstDate = new Date(`${dateKeys[0]}T00:00:00Z`);
  const lastDate = new Date(
    `${dateKeys[dateKeys.length - 1]}T00:00:00Z`
  );
  const ticks = [];
  let current = new Date(lastDate);

  while (current >= firstDate) {
    ticks.push(formatUTCDateKey(current));
    current.setUTCDate(current.getUTCDate() - 7);
  }

  const firstDateKey = formatUTCDateKey(firstDate);

  if (!ticks.includes(firstDateKey)) {
    ticks.push(firstDateKey);
  }

  return ticks.sort();
}

function getLatestComparisonPostDate(results) {
  let latestDate = null;

  results.forEach(result => {
    result.rows.forEach(row => {
      if (!row.PostTimeUTC) {
        return;
      }

      const postDate = new Date(row.PostTimeUTC);

      if (isNaN(postDate)) {
        return;
      }

      const postDateUTC = new Date(
        Date.UTC(
          postDate.getUTCFullYear(),
          postDate.getUTCMonth(),
          postDate.getUTCDate()
        )
      );

      if (
        latestDate === null ||
        postDateUTC > latestDate
      ) {
        latestDate = postDateUTC;
      }
    });
  });

  return latestDate;
}

function getComparisonDateKeys(
  includeProvisionalData = false,
  latestAvailableDate = null
) {
  const { start, end } = getTimeWindowUTC();
  const currentDate = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate()
    )
  );
  const lastDate = new Date(
    Date.UTC(
      end.getUTCFullYear(),
      end.getUTCMonth(),
      end.getUTCDate()
    )
  );

  if (includeProvisionalData) {
    const maximumProvisionalDate = new Date(lastDate);
    const todayUTC = new Date();

    todayUTC.setUTCHours(0, 0, 0, 0);

    const latestCompletedDate = new Date(todayUTC);

    latestCompletedDate.setUTCDate(
      latestCompletedDate.getUTCDate() - 1
    );

    maximumProvisionalDate.setUTCDate(
      maximumProvisionalDate.getUTCDate() +
      REPORTING_LAG_DAYS
    );

    const provisionalEndCandidates = [
      maximumProvisionalDate,
      latestCompletedDate
    ];

    if (latestAvailableDate) {
      provisionalEndCandidates.push(
        latestAvailableDate
      );
    }

    const provisionalEndDate = new Date(
      Math.min(
        ...provisionalEndCandidates.map(
          date => date.getTime()
        )
      )
    );

    if (provisionalEndDate > lastDate) {
      lastDate.setTime(provisionalEndDate.getTime());
    }
  }

  const dateKeys = [];

  while (currentDate <= lastDate) {
    dateKeys.push(formatUTCDateKey(currentDate));
    currentDate.setUTCDate(
      currentDate.getUTCDate() + 1
    );
  }

  return dateKeys;
}

function calculateDailyPostCounts(
  rows,
  dateKeys
) {
  const countsByDate = new Map(
    dateKeys.map(dateKey => [dateKey, 0])
  );

  rows.forEach(row => {
    if (!row.PostTimeUTC) {
      return;
    }

    const postDate = new Date(row.PostTimeUTC);

    if (isNaN(postDate)) {
      return;
    }

    const dateKey = formatUTCDateKey(postDate);

    if (countsByDate.has(dateKey)) {
      countsByDate.set(
        dateKey,
        countsByDate.get(dateKey) + 1
      );
    }
  });

  return dateKeys.map(
    dateKey => countsByDate.get(dateKey)
  );
}

function renderDailyPostControls(
  chartElement,
  traces
) {
  const controls = document.getElementById(
    "daily-posts-checkboxes"
  );

  controls.replaceChildren();

  traces.forEach((trace, traceIndex) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const labelText = document.createElement("span");

    label.className = "daily-posts-option";
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.style.accentColor = trace.line.color;
    checkbox.dataset.traceIndex =
      traceIndex.toString();
    labelText.textContent = trace.name;

    checkbox.addEventListener(
      "change",
      () => {
        Plotly.restyle(
          chartElement,
          {
            visible: checkbox.checked
          },
          [traceIndex]
        );
      }
    );

    label.append(checkbox, labelText);
    controls.appendChild(label);
  });
}

function renderDailyPostsComparison(results) {
  const chartElement = document.getElementById(
    "daily-posts-comparison-chart"
  );
  const provisionalCheckbox = document.getElementById(
    "show-provisional-data"
  );
  const cardTitle = document.getElementById(
    "daily-posts-card-title"
  );
  const startDateSlider = document.getElementById(
    "daily-posts-start-date"
  );
  const endDateSlider = document.getElementById(
    "daily-posts-end-date"
  );
  const startDateLabel = document.getElementById(
    "daily-posts-start-date-label"
  );
  const endDateLabel = document.getElementById(
    "daily-posts-end-date-label"
  );

  chartElement.textContent = "";

  const sortedResults = [...results].sort(
    (first, second) =>
      first.subreddit.localeCompare(
        second.subreddit,
        undefined,
        { sensitivity: "base" }
      )
  );
  const latestAvailableDate =
    getLatestComparisonPostDate(sortedResults);
  const requestedUrl = new URL(window.location.href);
  const isRequestedDailyPostsCard =
    CardSharing.getRequestedCardId() === "daily-posts";
  const requestedProvisionalData =
    isRequestedDailyPostsCard &&
    requestedUrl.searchParams.get("provisional") === "1";
  const requestedStartDateKey =
    isRequestedDailyPostsCard
      ? requestedUrl.searchParams.get("start")
      : null;
  const requestedEndDateKey =
    isRequestedDailyPostsCard
      ? requestedUrl.searchParams.get("end")
      : null;
  let currentDateKeys = [];
  let requestedDateRangeApplied = false;

  provisionalCheckbox.checked = requestedProvisionalData;

  const updateDateRangeLabels = () => {
    if (currentDateKeys.length === 0) {
      return;
    }

    const startDateKey =
      currentDateKeys[Number(startDateSlider.value)];
    const endDateKey =
      currentDateKeys[Number(endDateSlider.value)];

    startDateLabel.textContent =
      formatDateRangeLabel(startDateKey);
    endDateLabel.textContent =
      formatDateRangeLabel(endDateKey);
    startDateSlider.dataset.dateKey = startDateKey;
    endDateSlider.dataset.dateKey = endDateKey;
  };

  const applySliderDateRange = () => {
    if (currentDateKeys.length === 0) {
      return;
    }

    const startIndex = Number(startDateSlider.value);
    const endIndex = Number(endDateSlider.value);
    const visibleDateKeys = currentDateKeys.slice(
      startIndex,
      endIndex + 1
    );

    updateDateRangeLabels();

    Plotly.relayout(
      chartElement,
      {
        "xaxis.range":
          getDateAxisRange(
            visibleDateKeys
          ),
        "xaxis.tickvals":
          getEndAnchoredWeeklyTicks(
            visibleDateKeys
          )
      }
    );
  };

  startDateSlider.addEventListener(
    "input",
    () => {
      if (
        Number(startDateSlider.value) >
        Number(endDateSlider.value)
      ) {
        endDateSlider.value =
          startDateSlider.value;
      }

      applySliderDateRange();
    }
  );

  endDateSlider.addEventListener(
    "input",
    () => {
      if (
        Number(endDateSlider.value) <
        Number(startDateSlider.value)
      ) {
        startDateSlider.value =
          endDateSlider.value;
      }

      applySliderDateRange();
    }
  );

  const updateChart = () => {
    const includeProvisionalData =
      provisionalCheckbox.checked;
    const dateKeys = getComparisonDateKeys(
      includeProvisionalData,
      latestAvailableDate
    );
    const previousStartIndex = Number(
      startDateSlider.value
    );
    const previousEndIndex = Number(
      endDateSlider.value
    );
    const hadPreviousDateRange =
      currentDateKeys.length > 0;
    const endWasLatest =
      !hadPreviousDateRange ||
      previousEndIndex ===
        Number(endDateSlider.max);
    const lastDateIndex = dateKeys.length - 1;

    currentDateKeys = dateKeys;
    startDateSlider.max =
      lastDateIndex.toString();
    endDateSlider.max =
      lastDateIndex.toString();
    startDateSlider.value = hadPreviousDateRange
      ? Math.min(
          previousStartIndex,
          lastDateIndex
        ).toString()
      : "0";
    endDateSlider.value = endWasLatest
      ? lastDateIndex.toString()
      : Math.min(
          previousEndIndex,
          lastDateIndex
        ).toString();

    if (!requestedDateRangeApplied) {
      const requestedStartIndex =
        requestedStartDateKey
          ? dateKeys.indexOf(
              requestedStartDateKey
            )
          : -1;
      const requestedEndIndex =
        requestedEndDateKey
          ? dateKeys.indexOf(
              requestedEndDateKey
            )
          : -1;

      if (requestedStartIndex >= 0) {
        startDateSlider.value =
          requestedStartIndex.toString();
      }

      if (requestedEndIndex >= 0) {
        endDateSlider.value =
          requestedEndIndex.toString();
      }

      requestedDateRangeApplied = true;
    }

    if (
      Number(startDateSlider.value) >
      Number(endDateSlider.value)
    ) {
      startDateSlider.value =
        endDateSlider.value;
    }

    const visibleDateKeys = dateKeys.slice(
      Number(startDateSlider.value),
      Number(endDateSlider.value) + 1
    );

    updateDateRangeLabels();

    const controls = document.getElementById(
      "daily-posts-checkboxes"
    );

    const traces = sortedResults.map(
      (result, index) => {
        const existingCheckbox =
          controls.querySelector(
            `input[data-trace-index="${index}"]`
          );

        return {
          type: "scatter",
          mode: "lines",
          name: `r/${result.subreddit}`,
          x: dateKeys,
          y: calculateDailyPostCounts(
            result.rows,
            dateKeys
          ),
          visible: existingCheckbox
            ? existingCheckbox.checked
            : true,
          line: {
            color:
              DAILY_POST_LINE_COLORS[index],
            width: 2
          },
          hovertemplate:
            "%{x|%b %d, %Y}<br>" +
            `r/${result.subreddit}: %{y:,} posts` +
            "<extra></extra>"
        };
      }
    );

    const { end } = getTimeWindowUTC();
    const lastReportedDateKey = formatUTCDateKey(end);
    const provisionalDateKeys = dateKeys.filter(
      dateKey => dateKey > lastReportedDateKey
    );
    const firstProvisionalDateKey =
      provisionalDateKeys[0];
    const lastProvisionalDateKey =
      provisionalDateKeys[
        provisionalDateKeys.length - 1
      ];
    const provisionalLabelDate =
      provisionalDateKeys.length > 0
        ? new Date(
            (
              new Date(
                `${firstProvisionalDateKey}T00:00:00Z`
              ).getTime() +
              new Date(
                `${lastProvisionalDateKey}T00:00:00Z`
              ).getTime()
            ) / 2
          ).toISOString()
        : null;
    const provisionalShapes =
      provisionalDateKeys.length > 0
        ? [
            {
              type: "rect",
              xref: "x",
              yref: "paper",
              x0: firstProvisionalDateKey,
              x1: lastProvisionalDateKey,
              y0: 0,
              y1: 1,
              fillcolor: "rgba(247, 196, 31, 0.12)",
              line: { width: 0 },
              layer: "below"
            },
            {
              type: "line",
              xref: "x",
              yref: "paper",
              x0: firstProvisionalDateKey,
              x1: firstProvisionalDateKey,
              y0: 0,
              y1: 1,
              line: {
                color: "rgba(150, 105, 20, 0.75)",
                width: 1,
                dash: "dot"
              }
            }
          ]
        : [];
    const provisionalAnnotations =
      provisionalDateKeys.length > 0
        ? [
            {
              xref: "x",
              yref: "paper",
              x: provisionalLabelDate,
              y: 1,
              text: "Provisional",
              showarrow: false,
              xanchor: "center",
              yanchor: "bottom",
              font: {
                size: 10,
                color: "rgb(120, 85, 20)"
              }
            }
          ]
        : [];

    cardTitle.textContent = includeProvisionalData
      ? `Total Posts per Day (Last ${DASHBOARD_CONFIG.analysisWindowDays} Days + ${provisionalDateKeys.length} Provisional Days)`
      : `Total Posts per Day (Last ${DASHBOARD_CONFIG.analysisWindowDays} Days)`;

    const layout = {
      margin: {
        t: 24,
        b: 70,
        l: 74,
        r: 24
      },
      hovermode: "closest",
      showlegend: false,
      shapes: provisionalShapes,
      annotations: provisionalAnnotations,
      xaxis: {
        title: "Date",
        type: "date",
        range:
          getDateAxisRange(
            visibleDateKeys
          ),
        tickmode: "array",
        tickvals:
          getEndAnchoredWeeklyTicks(
            visibleDateKeys
          ),
        tickformat: "%b %d",
        tickangle: -45,
        automargin: true
      },
      yaxis: {
        title: "Number of Posts",
        rangemode: "tozero",
        automargin: true
      }
    };

    Plotly.react(
      chartElement,
      traces,
      layout,
      {
        responsive: true,
        displaylogo: false
      }
    );

    if (controls.childElementCount === 0) {
      renderDailyPostControls(
        chartElement,
        traces
      );
    }
  };

  provisionalCheckbox.addEventListener(
    "change",
    updateChart
  );

  updateChart();
}

function renderTopThreePieChart(
  chartElement,
  calculation
) {
  if (calculation.totalPosts === 0) {
    chartElement.className +=
      " comparison-pie-empty";

    chartElement.textContent =
      "No posts are available for this time period.";

    return;
  }

  const colors =
    calculation.labels.map(
      (_, index) => {
        if (index === 0) {
          return COLORS.TOP1;
        }

        if (index === 1) {
          return COLORS.TOP2;
        }

        if (index === 2) {
          return COLORS.TOP3;
        }

        return COLORS.OTHERS;
      }
    );

  const data = [{
    type: "pie",
    labels: calculation.labels,
    values: calculation.values,
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
    domain: {
      x: [0, 1],
      y: [0, 1]
    }
  }];

  const layout = {
    margin: {
      t: 10,
      b: 50,
      l: 0,
      r: 0
    },
    legend: {
      orientation: "h",
      x: 0.5,
      xanchor: "center",
      y: -0.15
    }
  };

  Plotly.newPlot(
    chartElement,
    data,
    layout
  );
}

function renderTopThreeComparison(results) {
  const grid =
    document.getElementById(
      "top-three-comparison-grid"
    );

  grid.innerHTML = "";

  const sortedResults =
    [...results].sort(
      (a, b) =>
        b.topThreeCalculation
          .combinedPercentage -
        a.topThreeCalculation
          .combinedPercentage
    );

  sortedResults.forEach((result, index) => {
    const card =
      document.createElement("div");

    card.className =
      "metric-card comparison-pie-card";

    const subredditSlug = result.subreddit
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    CardSharing.addCopyLink(card, {
      cardId: `top-three-${subredditSlug}`,
      analyticsCardId: "top-three",
      analyticsSubreddit: result.subreddit,
      cardTitle:
        `Top 3 Users in r/${result.subreddit}`
    });

    const heading =
      document.createElement("div");

    heading.className =
      "metric-label";

    heading.textContent =
      `Top 3 Users (Last ${DASHBOARD_CONFIG.analysisWindowDays} Days)`;

    const subredditName =
      document.createElement("div");

    subredditName.className =
      "comparison-pie-subreddit";

    subredditName.textContent =
      `r/${result.subreddit}`;

    const rank =
      document.createElement("div");

    rank.className =
      "comparison-pie-rank";

    rank.textContent =
      `#${index + 1} of ${sortedResults.length}`;

    const combinedShare =
      document.createElement("div");

    combinedShare.className =
      "comparison-pie-total";

    combinedShare.textContent =
      `${result.topThreeCalculation
        .combinedPercentage
        .toFixed(2)}% of the most recent ` +
      `${result.topThreeCalculation
        .totalPosts
        .toLocaleString()} posts`;

    const chart =
      document.createElement("div");

    chart.className =
      "comparison-pie-chart";

    card.appendChild(subredditName);
    card.appendChild(rank);
    card.appendChild(heading);
    card.appendChild(combinedShare);
    card.appendChild(chart);
    grid.appendChild(card);

    renderTopThreePieChart(
      chart,
      result.topThreeCalculation
    );
  });
}

function interpolateColor(
  startColor,
  endColor,
  amount
) {
  const values = startColor.map(
    (startValue, index) => {
      const endValue =
        endColor[index];

      return Math.round(
        startValue +
        (
          endValue - startValue
        ) * amount
      );
    }
  );

  return (
    `rgb(` +
    `${values[0]},` +
    `${values[1]},` +
    `${values[2]}` +
    `)`
  );
}

function getThresholdTileColor(
  normalizedValue
) {
  const pastelRed = [
    239,
    154,
    154
  ];

  const pastelYellow = [
    255,
    224,
    130
  ];

  const pastelGreen = [
    165,
    214,
    167
  ];

  /*
   * Lower half:
   * pastel red → pastel yellow
   */
  if (normalizedValue <= 0.5) {
    return interpolateColor(
      pastelRed,
      pastelYellow,
      normalizedValue * 2
    );
  }

  /*
   * Upper half:
   * pastel yellow → pastel green
   */
  return interpolateColor(
    pastelYellow,
    pastelGreen,
    (normalizedValue - 0.5) * 2
  );
}

function getRankTraceColor(
  rankNumber,
  totalRanks
) {
  const rankColors = [
    "#d62728",
    "#1f77b4",
    "#2ca02c",
    "#ff7f0e",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#17becf",
    "#bcbd22",
    "#7f7f7f",
    "#393b79",
    "#637939",
    "#8c6d31"
  ];

  return rankColors[
    (rankNumber - 1) % rankColors.length
  ];
}

function calculateColumnRankNormalizations(
  results
) {
  return POST_SHARE_THRESHOLDS.map(
    (_, columnIndex) => {
      /*
       * Retain each value's original row
       * position while sorting the column.
       */
      const rankedEntries =
        results
          .map(
            (result, rowIndex) => ({
              rowIndex,

              value:
                result
                  .thresholdCalculation
                  .posterPercentages[
                    columnIndex
                  ]
            })
          )
          .sort(
            (a, b) =>
              a.value - b.value
          );

      const normalizedByRow =
        new Array(results.length);

      let position = 0;

      while (
        position <
        rankedEntries.length
      ) {
        /*
         * Find all entries tied at the
         * current value.
         */
        let tiedThrough = position;

        while (
          tiedThrough + 1 <
            rankedEntries.length &&
          rankedEntries[
            tiedThrough + 1
          ].value ===
            rankedEntries[position].value
        ) {
          tiedThrough++;
        }

        /*
         * Tied values receive their
         * average rank.
         */
        const averageRank =
          (
            position +
            tiedThrough
          ) / 2;

        let normalizedRank = 0.5;

        if (rankedEntries.length > 1) {
          normalizedRank =
            averageRank /
            (
              rankedEntries.length - 1
            );
        }

        for (
          let tiedPosition = position;
          tiedPosition <= tiedThrough;
          tiedPosition++
        ) {
          const originalRowIndex =
            rankedEntries[
              tiedPosition
            ].rowIndex;

          normalizedByRow[
            originalRowIndex
          ] = normalizedRank;
        }

        position = tiedThrough + 1;
      }

      return normalizedByRow;
    }
  );
}

function getTopPosterPercentageRows(
  results,
  rankCount = results.length
) {
  /*
   * The 100% column is deliberately excluded:
   * every subreddit requires 100% of its unique
   * posters to account for 100% of valid posts.
   */
  const rankedRowsByColumn =
    POST_SHARE_THRESHOLDS
      .slice(0, -1)
      .map((_, columnIndex) => {
        return results
          .map((result, rowIndex) => ({
            rowIndex,
            percentage:
              result
                .thresholdCalculation
                .posterPercentages[
                  columnIndex
                ]
          }))
          .sort((a, b) => {
            return (
              a.percentage - b.percentage ||
              a.rowIndex - b.rowIndex
            );
          })
          .slice(0, rankCount)
          .map(entry => entry.rowIndex);
      });

  return Array.from(
    { length: rankCount },
    (_, rankIndex) => {
      return rankedRowsByColumn.map(
        columnRows =>
          columnRows[rankIndex]
      );
    }
  );
}

function drawPosterPercentageRankLine(
  grid,
  rankedTiles,
  rankNumber,
  totalRanks
) {
  if (rankedTiles.some(tile => !tile)) {
    return;
  }

  const svgNamespace =
    "http://www.w3.org/2000/svg";

  const overlay =
    document.createElementNS(
      svgNamespace,
      "svg"
    );

  overlay.classList.add(
    "poster-threshold-line-overlay"
  );

  overlay.dataset.rank =
    rankNumber.toString();

  if (rankNumber > 1) {
    overlay.classList.add("is-hidden");
  }

  overlay.setAttribute(
    "viewBox",
    `0 0 ${grid.scrollWidth} ${grid.scrollHeight}`
  );

  overlay.setAttribute(
    "aria-hidden",
    "true"
  );

  const vertices = rankedTiles
    .map(tile => ({
      x:
        tile.offsetLeft +
        tile.offsetWidth - 7,

      y:
        tile.offsetTop + 7
    }));

  const points = vertices
    .map(vertex =>
      `${vertex.x},${vertex.y}`
    )
    .join(" ");

  const line =
    document.createElementNS(
      svgNamespace,
      "polyline"
    );

  line.classList.add(
    "poster-threshold-rank-line"
  );

  const rankColor =
    getRankTraceColor(
      rankNumber,
      totalRanks
    );

  line.style.stroke = rankColor;

  line.setAttribute("points", points);
  overlay.appendChild(line);

  vertices.forEach(vertex => {
    const dot =
      document.createElementNS(
        svgNamespace,
        "circle"
      );

    dot.classList.add(
      "poster-threshold-rank-dot"
    );

    dot.style.fill = rankColor;

    dot.setAttribute("cx", vertex.x);
    dot.setAttribute("cy", vertex.y);
    dot.setAttribute("r", "4");
    overlay.appendChild(dot);
  });

  grid.appendChild(overlay);
}

function renderPosterRankingControls(
  grid,
  totalRanks
) {
  const controls =
    document.getElementById(
      "poster-ranking-checkboxes"
    );

  controls.innerHTML = "";

  for (
    let rankNumber = 1;
    rankNumber <= totalRanks;
    rankNumber++
  ) {
    const label =
      document.createElement("label");

    label.className =
      "poster-ranking-option";

    const checkbox =
      document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = rankNumber === 1;
    checkbox.dataset.rank =
      rankNumber.toString();
    checkbox.style.accentColor =
      getRankTraceColor(
        rankNumber,
        totalRanks
      );

    checkbox.addEventListener(
      "change",
      () => {
        const overlay =
          grid.querySelector(
            `.poster-threshold-line-overlay[data-rank="${rankNumber}"]`
          );

        if (overlay) {
          overlay.classList.toggle(
            "is-hidden",
            !checkbox.checked
          );
        }
      }
    );

    const labelText =
      document.createElement("span");

    labelText.textContent =
      `Rank ${rankNumber}`;

    label.appendChild(checkbox);
    label.appendChild(labelText);
    controls.appendChild(label);
  }

  const url = new URL(window.location.href);
  const requestedRanks = url.searchParams
    .get("ranks");

  if (
    CardSharing.getRequestedCardId() ===
      "poster-threshold" &&
    requestedRanks
  ) {
    const rankSet = new Set(
      requestedRanks
        .split(",")
        .map(rank => Number(rank))
        .filter(rank =>
          Number.isInteger(rank) &&
          rank >= 1 &&
          rank <= totalRanks
        )
    );

    controls
      .querySelectorAll('input[type="checkbox"]')
      .forEach(checkbox => {
        checkbox.checked = rankSet.has(
          Number(checkbox.dataset.rank)
        );
        checkbox.dispatchEvent(new Event("change"));
      });
  }
}

function renderPosterThresholdGrid(
  results
) {
  const grid =
    document.getElementById(
      "poster-threshold-grid"
    );

  grid.innerHTML = "";
  grid.className =
    "poster-threshold-grid";

  const sortedResults =
    [...results].sort((a, b) => {
      return a.subreddit.localeCompare(
        b.subreddit,
        undefined,
        { sensitivity: "base" }
      );
    });

  /*
   * Each column receives its own
   * rank normalization.
   */
  const columnNormalizations =
    calculateColumnRankNormalizations(
      sortedResults
    );

  const rankedPercentageRows =
    getTopPosterPercentageRows(
      sortedResults
    );

  const rankedTiles =
    rankedPercentageRows.map(
      rowIndexes =>
        new Array(rowIndexes.length)
    );

  // Empty upper-left corner.
  const corner =
    document.createElement("div");

  corner.className =
    "poster-threshold-corner";

  grid.appendChild(corner);

  // Percentage headings.
  POST_SHARE_THRESHOLDS.forEach(
    threshold => {
      const header =
        document.createElement("div");

      header.className =
        "poster-threshold-header";

      header.textContent =
        `${Math.round(
          threshold * 100
        )}%`;

      grid.appendChild(header);
    }
  );

  const uniquePostersHeader =
    document.createElement("div");

  uniquePostersHeader.className =
    "poster-threshold-header " +
    "unique-posters-header";

  uniquePostersHeader.innerHTML =
    "Unique<br>Posters";

  uniquePostersHeader.title =
    "Number of unique named posters";

  grid.appendChild(
    uniquePostersHeader
  );

  const weeklyPostsHeader =
    document.createElement("div");

  weeklyPostsHeader.className =
    "poster-threshold-header " +
    "weekly-posts-header";

  weeklyPostsHeader.innerHTML =
    "Avg.<br>Weekly<br>Posts";

  weeklyPostsHeader.title =
    "Estimated posts per week based on " +
    `posts in the last ${DASHBOARD_CONFIG.analysisWindowDays} days`;

  grid.appendChild(
    weeklyPostsHeader
  );

  // One row per subreddit.
  sortedResults.forEach(
    (result, rowIndex) => {
      const rowLabel =
        document.createElement("div");

      rowLabel.className =
        "poster-threshold-row-label";

      rowLabel.textContent =
        `r/${result.subreddit}`;

      grid.appendChild(rowLabel);

      result
        .thresholdCalculation
        .posterPercentages
        .forEach(
          (
            posterPercentage,
            columnIndex
          ) => {
            const posterCount =
              result
                .thresholdCalculation
                .postersNeeded[
                  columnIndex
                ];

            const normalizedValue =
              columnNormalizations[
                columnIndex
              ][rowIndex];

            const tile =
              document.createElement(
                "div"
              );

            tile.className =
              "poster-threshold-tile";

            const isHundredPercentColumn =
              columnIndex ===
              POST_SHARE_THRESHOLDS.length - 1;

            if (isHundredPercentColumn) {
              tile.classList.add(
                "poster-threshold-neutral-tile"
              );
            }

            rankedPercentageRows.forEach(
              (rowIndexes, rankIndex) => {
                if (
                  columnIndex <
                    rowIndexes.length &&
                  rowIndex ===
                    rowIndexes[columnIndex]
                ) {
                  rankedTiles[
                    rankIndex
                  ][columnIndex] = tile;
                }
              }
            );

            /*
            * One decimal place keeps the
            * percentage readable in a
            * 50-pixel tile.
            */
            const tileText =
              document.createElement("span");

            tileText.className =
              "poster-threshold-tile-text";

            tileText.textContent =
              `${posterPercentage.toFixed(1)}%`;

            tile.appendChild(tileText);

            if (!isHundredPercentColumn) {
              tile.style.backgroundColor =
                getThresholdTileColor(
                  normalizedValue
                );
            }

            const postPercentage =
              Math.round(
                POST_SHARE_THRESHOLDS[
                  columnIndex
                ] * 100
              );

            tile.title =
              `r/${result.subreddit}: ` +
              `${posterCount.toLocaleString()} of ` +
              `${result.thresholdCalculation
                .totalUniquePosters
                .toLocaleString()} unique posters ` +
              `(${posterPercentage.toFixed(2)}%) ` +
              `are needed to account for ` +
              `${postPercentage}% of ` +
              `${result.thresholdCalculation
                .totalUsablePosts
                .toLocaleString()} valid posts`;

            grid.appendChild(tile);
          }
        );

        const uniquePostersTile =
          document.createElement("div");

        uniquePostersTile.className =
          "poster-threshold-tile " +
          "unique-posters-tile";

        uniquePostersTile.textContent =
          result
            .thresholdCalculation
            .totalUniquePosters
            .toLocaleString();

        uniquePostersTile.title =
          `r/${result.subreddit}: ` +
          `${result.thresholdCalculation
            .totalUniquePosters
            .toLocaleString()} unique named posters ` +
          `in the last ` +
          `${DASHBOARD_CONFIG.analysisWindowDays} days`;

        grid.appendChild(
          uniquePostersTile
        );

        const weeklyPostsTile =
          document.createElement("div");

        weeklyPostsTile.className =
          "poster-threshold-tile " +
          "weekly-posts-tile";

        weeklyPostsTile.textContent =
          result
            .thresholdCalculation
            .estimatedWeeklyPosts
            .toLocaleString();

        weeklyPostsTile.title =
          `r/${result.subreddit}: ` +
          `approximately ` +
          `${result.thresholdCalculation
            .estimatedWeeklyPosts
            .toLocaleString()} posts per week. ` +
          `Calculated from ` +
          `${result.thresholdCalculation
            .activitySamplePosts
            .toLocaleString()} posts during the last ` +
          `${result.thresholdCalculation
            .activityWindowDays
            .toLocaleString()} days.`;

        grid.appendChild(
          weeklyPostsTile
        );

    }
  );

  rankedTiles.forEach(
    (tiles, rankIndex) => {
      drawPosterPercentageRankLine(
        grid,
        tiles,
        rankIndex + 1,
        rankedTiles.length
      );
    }
  );

  renderPosterRankingControls(
    grid,
    rankedTiles.length
  );
}

function renderTopPosterShareChart(
  results,
  posterCount
) {
  const calculatedResults =
    results.map(result => ({
      subreddit: result.subreddit,
      ...calculateTopPosterShare(
        result.rows,
        posterCount
      )
    }));

  const sortedResults =
    calculatedResults.sort(
      (a, b) =>
        b.percentage - a.percentage
    );

  const subredditNames =
    sortedResults.map(result => {
      return (
        `r/${result.subreddit} ` +
        `(${result.topPosterPosts.toLocaleString()} / ` +
        `${result.totalPosts.toLocaleString()} posts)`
      );
    });
  const percentages =
    sortedResults.map(
      result => result.percentage
    );

  const customData =
    sortedResults.map(result => [
      result.topPosterPosts,
      result.totalPosts
    ]);

  const barColors =
    sortedResults.map((result, index) => {
      const normalizedRank =
        sortedResults.length > 1
          ? index /
            (sortedResults.length - 1)
          : 0.5;

      return getThresholdTileColor(
        normalizedRank
      );
    });

  const trace = {
    type: "bar",
    orientation: "h",

    y: subredditNames,
    x: percentages,

    customdata: customData,

    marker: {
      color: barColors
    },

    text: percentages.map(
      value => `${value.toFixed(2)}%`
    ),

    textposition: "outside",

    hovertemplate:
      "<b>%{y}</b><br>" +
      `Posts by top ${posterCount}: ` +
      "%{customdata[0]:,}<br>" +
      "Total posts: %{customdata[1]:,}<br>" +
      "Percentage: %{x:.2f}%" +
      "<extra></extra>"
  };

  const largestPercentage =
    Math.max(...percentages);

  const layout = {
    margin: {
      t: 20,
      b: 60,
      l: 180,
      r: 80
    },

    xaxis: {
      title: "Percentage of All Posts",
      range: [
        0,
        Math.min(
          100,
          largestPercentage + 8
        )
      ],
      ticksuffix: "%"
    },

    yaxis: {
      autorange: "reversed",
      automargin: true
    }
  };

  Plotly.react(
    "top10-share-comparison-chart",
    [trace],
    layout,
    {
      responsive: true
    }
  );
}

function initializeTopPosterShareChart(
  results
) {
  const selector =
    document.getElementById("top-x-select");

  const requestedPosterCount = Number(
    new URL(window.location.href)
      .searchParams
      .get("top")
  );

  const hasSharedPosterCount =
    CardSharing.getRequestedCardId() === "top-x" &&
    Number.isInteger(requestedPosterCount) &&
    requestedPosterCount >= 1 &&
    requestedPosterCount <= 10;

  const initialPosterCount = hasSharedPosterCount
    ? requestedPosterCount
    : Math.floor(Math.random() * 10) + 1;

  selector.value =
    String(initialPosterCount);

  const updateChart = () => {
    const posterCount =
      Number(selector.value);

    renderTopPosterShareChart(
      results,
      posterCount
    );
  };

  selector.addEventListener(
    "change",
    updateChart
  );

  updateChart();
}

function initializeComparisonSharing() {
  const dailyPostsCard =
    document.getElementById("daily-posts-comparison-card");
  const posterThresholdCard =
    document.getElementById("poster-threshold-card");
  const topXCard =
    document.getElementById("top-x-posters-card");

  CardSharing.addCopyLink(dailyPostsCard, {
    cardId: "daily-posts",
    cardTitle:
      "Total Posts per Day",
    getState: () => ({
      provisional:
        document.getElementById(
          "show-provisional-data"
        ).checked
          ? "1"
          : "0",
      start:
        document.getElementById(
          "daily-posts-start-date"
        ).dataset.dateKey || "",
      end:
        document.getElementById(
          "daily-posts-end-date"
        ).dataset.dateKey || ""
    })
  });

  CardSharing.addCopyLink(posterThresholdCard, {
    cardId: "poster-threshold",
    cardTitle:
      "Percentage of Unique Posters Needed to Account for X% of Posts",
    getState: () => {
      const selectedRanks = Array.from(
        document.querySelectorAll(
          '#poster-ranking-checkboxes input[type="checkbox"]:checked'
        )
      ).map(checkbox => checkbox.dataset.rank);

      return {
        ranks: selectedRanks.length > 0
          ? selectedRanks.join(",")
          : "none"
      };
    }
  });

  CardSharing.addCopyLink(topXCard, {
    cardId: "top-x",
    cardTitle:
      "Percentage of Posts Made by the Top X Posters",
    getState: () => ({
      top: document.getElementById("top-x-select").value
    })
  });
}

function isPublicPseudonym(username) {
  return (
    typeof username === "string" &&
    /^User_[a-z2-7]{8}$/i.test(
      username.trim()
    )
  );
}

function calculateContributionGroup(
  rows,
  targetShare
) {
  const usablePosts =
    filterToTimeWindow(rows)
      .filter(row =>
        isUsableUsername(row.Username)
      );

  const totalPosts = usablePosts.length;

  if (totalPosts === 0) {
    return [];
  }

  const userCounts = new Map();

  usablePosts.forEach(row => {
    const username = row.Username.trim();
    const normalizedUsername =
      username.toLowerCase();
    const existing =
      userCounts.get(normalizedUsername);

    if (existing) {
      existing.posts++;
    } else {
      userCounts.set(
        normalizedUsername,
        {
          username,
          posts: 1
        }
      );
    }
  });

  const sortedUsers =
    Array.from(userCounts.values())
      .sort((first, second) =>
        second.posts - first.posts
      );

  const targetPosts =
    totalPosts * targetShare;
  const selectedUsers = [];
  let cumulativePosts = 0;

  for (const user of sortedUsers) {
    selectedUsers.push(user);
    cumulativePosts += user.posts;

    if (cumulativePosts >= targetPosts) {
      break;
    }
  }

  if (selectedUsers.length === 0) {
    return selectedUsers;
  }

  // Include every account tied with the account at the cutoff.
  const boundaryPostCount =
    selectedUsers[selectedUsers.length - 1]
      .posts;

  for (
    let index = selectedUsers.length;
    index < sortedUsers.length;
    index++
  ) {
    if (
      sortedUsers[index].posts !==
      boundaryPostCount
    ) {
      break;
    }

    selectedUsers.push(sortedUsers[index]);
  }

  return selectedUsers;
}

function findCrossSubredditUsers(
  results,
  targetShare
) {
  const memberships = new Map();

  results.forEach(result => {
    const contributionGroup =
      calculateContributionGroup(
        result.rows,
        targetShare
      );

    contributionGroup.forEach(user => {
      // Never render a raw Reddit username if an unsanitized file is
      // accidentally copied into the public dashboard data directory.
      if (!isPublicPseudonym(user.username)) {
        return;
      }

      const normalizedUsername =
        user.username.toLowerCase();
      const existing =
        memberships.get(normalizedUsername);

      if (existing) {
        existing.subreddits.push(
          result.subreddit
        );
      } else {
        memberships.set(
          normalizedUsername,
          {
            username: user.username,
            subreddits: [
              result.subreddit
            ]
          }
        );
      }
    });
  });

  return Array.from(memberships.values())
    .filter(entry =>
      entry.subreddits.length >= 2
    )
    .map(entry => ({
      ...entry,
      subreddits: entry.subreddits
        .sort((first, second) =>
          first.localeCompare(
            second,
            undefined,
            { sensitivity: "base" }
          )
        )
    }))
    .sort((first, second) => {
      const subredditDifference =
        second.subreddits.length -
        first.subreddits.length;

      if (subredditDifference !== 0) {
        return subredditDifference;
      }

      return first.username.localeCompare(
        second.username,
        undefined,
        { sensitivity: "base" }
      );
    });
}

function renderCrossSubredditUserList(
  elementId,
  users
) {
  const listElement =
    document.getElementById(elementId);

  listElement.replaceChildren();

  if (users.length === 0) {
    const emptyMessage =
      document.createElement("div");

    emptyMessage.className =
      "cross-subreddit-overlap-empty";
    emptyMessage.textContent =
      "No pseudonymized users meet this condition.";
    listElement.appendChild(emptyMessage);
    return;
  }

  users.forEach(user => {
    const row = document.createElement("div");
    const username = document.createElement("div");
    const subreddits = document.createElement("div");

    row.className =
      "cross-subreddit-overlap-row";
    username.className =
      "cross-subreddit-overlap-username";
    subreddits.className =
      "cross-subreddit-overlap-subreddits";

    username.textContent = user.username;
    subreddits.textContent =
      user.subreddits
        .map(subreddit => `r/${subreddit}`)
        .join(", ");

    row.append(username, subreddits);
    listElement.appendChild(row);
  });
}

function renderCrossSubredditOverlap(
  results
) {
  renderCrossSubredditUserList(
    "cross-subreddit-10-list",
    findCrossSubredditUsers(
      results,
      0.10
    )
  );

  renderCrossSubredditUserList(
    "cross-subreddit-25-list",
    findCrossSubredditUsers(
      results,
      0.25
    )
  );
}

async function initializeComparison() {
  try {
    initializeComparisonSharing();

    const results = await Promise.all(
      SUBREDDITS.map(
        subreddit =>
          loadSubredditData(subreddit)
      )
    );

    renderDailyPostsComparison(results);
    renderTopThreeComparison(results);
    initializeTopPosterShareChart(results);
    renderPosterThresholdGrid(results);
    renderCrossSubredditOverlap(results);

    CardSharing.focusRequestedCard();

  } catch (error) {
    console.error(error);

    document.getElementById(
      "daily-posts-comparison-chart"
    ).innerText =
      "Daily post totals could not be loaded.";

    document.getElementById(
      "top10-share-comparison-chart"
    ).innerText =
      "Comparison data could not be loaded.";

    document.getElementById(
      "top-three-comparison-grid"
    ).innerText =
      "Top-three comparison data could not be loaded.";

    [
      "cross-subreddit-10-list",
      "cross-subreddit-25-list"
    ].forEach(elementId => {
      document.getElementById(
        elementId
      ).innerText =
        "Cross-subreddit comparison data could not be loaded.";
    });
  }
}

initializeComparison();
