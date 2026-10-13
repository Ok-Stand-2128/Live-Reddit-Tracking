"""Reference implementation of the local subreddit activity collector.

This public copy contains the collection, validation, staging, backup, and
authoritative merge logic used by the project. Private credential values,
machine-specific locations, notifications, and deployment automation are
intentionally omitted. Runtime storage is configured through the
``SUBREDDIT_ACTIVITY_DATA_DIR`` environment variable.

After a successful private collection run, a separate downstream process uses a
secret keyed hash to replace named Reddit accounts with stable pseudonyms. That
process publishes only PostID, pseudonymized Username, and PostTimeUTC fields to
the public dashboard data folder. Deleted and unavailable usernames are handled
as special non-identifying values rather than assigned account pseudonyms.

The current transport reads public Reddit listing responses through a browser.
It is intended to be replaced by OAuth-authenticated Data API requests if Reddit
approves the application's access request; the data-selection and merge rules
shown here will remain the same.

For each configured subreddit, this script:

1. Loads its authoritative CSV and JSON.
2. Finds the newest post currently in the authoritative collection.
3. Scrapes backward to three days before that post.
4. Ignores new posts less than three hours old.
5. Adds eligible posts whose PostID is not already authoritative.
6. Refreshes num_comments, ups, and upvote_ratio for existing posts in
   the three-day engagement window.
7. Updates the authoritative CSV and JSON only after adequate overlap
   has been established.
8. Saves each run's fetched data and logs for auditing.
"""

from __future__ import annotations

import csv
import json
import os
import random
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from selenium import webdriver
from selenium.common.exceptions import (
    JavascriptException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MULTIPLE_SUBS_DIR = Path(
    os.environ.get(
        "SUBREDDIT_ACTIVITY_DATA_DIR",
        str(Path.home() / "subreddit_activity_data"),
    )
).expanduser()

AUTHORITATIVE_DIR = (
    MULTIPLE_SUBS_DIR
    / "authoritative_jsons_csvs"
)

DAILY_RUNS_DIR = MULTIPLE_SUBS_DIR / "daily_runs"

BACKUP_ROOT_DIR = (
    MULTIPLE_SUBS_DIR
    / "authoritative_backups"
)

MASTER_LOG_PATH = (
    MULTIPLE_SUBS_DIR
    / "daily_master_log.csv"
)

CHROME_PROFILE_DIR = (
    MULTIPLE_SUBS_DIR
    / "_reddit_chrome_profile"
)

LOCK_PATH = (
    MULTIPLE_SUBS_DIR
    / "subreddit_activity_collector.lock"
)

SUBREDDITS = [
    "politics",
    "conspiracy",
    "worldnews",
    "Conservative",
    "AnythingGoesNews",
    "ProgressiveHQ",
    "antitrump",
    "ukpolitics",
    "trump",
    "neoliberal",
    "CanadaPolitics",
    "socialism",
    "democrats",
]

ENGAGEMENT_REFRESH_DAYS = 3
MODERATION_DELAY_HOURS = 3
MAX_DAILY_PAGES = 10
POSTS_PER_PAGE = 100

PAGE_LOAD_TIMEOUT_SECONDS = 45
JSON_WAIT_TIMEOUT_SECONDS = 30
MAX_REQUEST_ATTEMPTS = 3

PAUSE_BETWEEN_PAGES = (3.0, 6.0)
PAUSE_BETWEEN_SUBREDDITS = (5.0, 10.0)

RATE_LIMIT_RETRY_SECONDS = 60
RATE_LIMIT_COOLDOWN_SECONDS = 120

POST_FIELDS = [
    "RunTimestampUTC",
    "Subreddit",
    "PostID",
    "Username",
    "PostTimeUTC",
    "Title",
    "SelfText",
    "PostFlair",
    "Domain",
    "IsSelfPost",
    "NSFW",
    "Spoiler",
    "Stickied",
    "Locked",
    "Votes",
    "UpvoteRatio",
    "Comments",
    "ExternalURL",
    "PostURL",
]

LOG_FIELDS = [
    "RunTimestampUTC",
    "Subreddit",
    "Result",
    "HTTPStatus",
    "PagesCompleted",
    "PostsFetched",
    "KnownOverlapPosts",
    "NewPostsAdded",
    "ExistingPostsUpdated",
    "CommentsChanged",
    "VotesChanged",
    "UpvoteRatioChanged",
    "RecentPostsSkipped",
    "AuthoritativeRowsBefore",
    "AuthoritativeRowsAfter",
    "LatestAuthoritativePostUTC",
    "RefreshBoundaryUTC",
    "ModerationCutoffUTC",
    "OldestFetchedPostUTC",
    "AuthoritativeCSV",
    "AuthoritativeJSON",
    "ElapsedSeconds",
    "Message",
]


# ---------------------------------------------------------------------------
# General helpers
# ---------------------------------------------------------------------------

def utc_text(value: datetime | float | int) -> str:
    """Return an ISO-8601 UTC timestamp."""
    if isinstance(value, datetime):
        result = value
    else:
        result = datetime.fromtimestamp(
            value,
            tz=timezone.utc,
        )

    if result.tzinfo is None:
        result = result.replace(
            tzinfo=timezone.utc,
        )

    return result.astimezone(
        timezone.utc
    ).isoformat()


def parse_utc(value: str) -> datetime:
    """Parse an ISO-8601 timestamp as an aware UTC datetime."""
    text = (value or "").strip()

    if not text:
        raise ValueError(
            "A required timestamp is blank."
        )

    parsed = datetime.fromisoformat(
        text.replace("Z", "+00:00")
    )

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=timezone.utc,
        )

    return parsed.astimezone(
        timezone.utc
    )


def post_datetime(
    post: dict[str, Any],
) -> datetime | None:
    """Return a post's created_utc value as a UTC datetime."""
    created_utc = post.get("created_utc")

    if created_utc is None:
        return None

    try:
        return datetime.fromtimestamp(
            float(created_utc),
            tz=timezone.utc,
        )
    except (TypeError, ValueError, OSError):
        return None


def post_key(
    post: dict[str, Any],
) -> str:
    """Return the stable Reddit identifier for a post."""
    post_id = (
        post.get("id")
        or post.get("name")
        or post.get("permalink")
    )

    if not post_id:
        raise ValueError(
            "A Reddit post had no ID, name, or permalink."
        )

    return str(post_id)


def parse_int(
    value: Any,
    default: int = 0,
) -> int:
    """Safely convert a value to an integer."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def parse_float(
    value: Any,
    default: float = 0.0,
) -> float:
    """Safely convert a value to a float."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def append_log(
    log_path: Path,
    row: dict[str, Any],
) -> None:
    """Append one row to a CSV log."""
    log_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    needs_header = (
        not log_path.exists()
        or log_path.stat().st_size == 0
    )

    with log_path.open(
        "a",
        newline="",
        encoding="utf-8-sig",
    ) as file:
        writer = csv.DictWriter(
            file,
            fieldnames=LOG_FIELDS,
            extrasaction="ignore",
        )

        if needs_header:
            writer.writeheader()

        writer.writerow(row)


# ---------------------------------------------------------------------------
# Chrome and Reddit request helpers
# ---------------------------------------------------------------------------

def create_chrome_driver() -> webdriver.Chrome:
    """Create a visible Chrome browser with a persistent profile."""
    CHROME_PROFILE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    options = Options()

    options.add_argument(
        f"--user-data-dir={str(CHROME_PROFILE_DIR)}"
    )

    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_argument("--disable-popup-blocking")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--lang=en-US")

    options.add_experimental_option(
        "excludeSwitches",
        ["enable-logging"],
    )

    driver = webdriver.Chrome(
        options=options
    )

    driver.set_page_load_timeout(
        PAGE_LOAD_TIMEOUT_SECONDS
    )

    return driver


def get_browser_text(
    driver: webdriver.Chrome,
) -> str:
    """Return the visible text in the browser body."""
    text = driver.execute_script(
        """
        if (!document.body) {
            return "";
        }

        return (
            document.body.innerText
            || document.body.textContent
            || ""
        );
        """
    )

    return (
        str(text).strip()
        if text is not None
        else ""
    )


def browser_contains_json(
    driver: webdriver.Chrome,
) -> bool:
    """Return True if Chrome contains a Reddit Listing document."""
    try:
        text = get_browser_text(driver)

        if not text:
            return False

        payload = json.loads(text)

        return (
            isinstance(payload, dict)
            and payload.get("kind") == "Listing"
            and isinstance(
                payload.get("data"),
                dict,
            )
        )

    except (
        json.JSONDecodeError,
        JavascriptException,
        WebDriverException,
    ):
        return False


def extract_http_status_from_page(
    text: str,
) -> int | str:
    """Infer an HTTP status from a Chrome or Reddit error page."""
    lowered = text.lower()

    if (
        "too many requests" in lowered
        or "rate limit" in lowered
        or "http error 429" in lowered
        or "status code 429" in lowered
    ):
        return 429

    if (
        "forbidden" in lowered
        or "you've been blocked" in lowered
    ):
        return 403

    if (
        "not found" in lowered
        or "page not found" in lowered
    ):
        return 404

    if (
        "internal server error" in lowered
        or "server error" in lowered
        or "reddit is down" in lowered
    ):
        return 500

    if "this site can't be reached" in lowered:
        return "BROWSER_ERROR"

    return ""


def parse_browser_error(
    exc: RuntimeError,
) -> tuple[int | str, str]:
    """Extract a status and message stored by visit_listing."""
    try:
        details = json.loads(str(exc))

        if isinstance(details, dict):
            return (
                details.get("status", ""),
                str(
                    details.get(
                        "message",
                        exc,
                    )
                ),
            )

    except json.JSONDecodeError:
        pass

    return "", str(exc)


def visit_listing(
    driver: webdriver.Chrome,
    url: str,
) -> tuple[int | str, dict[str, Any]]:
    """Open and parse one Reddit JSON listing."""
    last_status: int | str = ""
    last_message = ""

    for attempt in range(
        1,
        MAX_REQUEST_ATTEMPTS + 1,
    ):
        print(
            f"        Browser attempt "
            f"{attempt}/{MAX_REQUEST_ATTEMPTS}"
        )

        try:
            driver.get(url)

            WebDriverWait(
                driver,
                JSON_WAIT_TIMEOUT_SECONDS,
            ).until(
                browser_contains_json
            )

            payload = json.loads(
                get_browser_text(driver)
            )

            if not isinstance(payload, dict):
                raise ValueError(
                    "Reddit returned unexpected JSON."
                )

            return 200, payload

        except TimeoutException:
            page_text = ""

            try:
                page_text = get_browser_text(
                    driver
                )
            except WebDriverException:
                pass

            last_status = (
                extract_http_status_from_page(
                    page_text
                )
            )

            excerpt = (
                page_text[:500]
                .replace("\r", " ")
                .replace("\n", " ")
            )

            last_message = (
                "Timed out waiting for Reddit JSON."
                + (
                    f" Browser text: {excerpt}"
                    if excerpt
                    else ""
                )
            )

        except json.JSONDecodeError as exc:
            page_text = get_browser_text(
                driver
            )

            last_status = (
                extract_http_status_from_page(
                    page_text
                )
            )

            excerpt = (
                page_text[:500]
                .replace("\r", " ")
                .replace("\n", " ")
            )

            last_message = (
                f"Could not parse browser content: "
                f"{exc}. Browser text: {excerpt}"
            )

        except (
            JavascriptException,
            WebDriverException,
            ValueError,
        ) as exc:
            last_message = (
                f"{type(exc).__name__}: {exc}"
            )

        if attempt < MAX_REQUEST_ATTEMPTS:
            if last_status == 429:
                wait_seconds = (
                    RATE_LIMIT_RETRY_SECONDS
                    * attempt
                )
            else:
                wait_seconds = 10 * attempt

            print(
                f"        Waiting {wait_seconds} "
                "seconds before retrying..."
            )

            time.sleep(wait_seconds)

    raise RuntimeError(
        json.dumps(
            {
                "status": last_status,
                "message": (
                    last_message
                    or "Browser request failed."
                ),
            }
        )
    )


def build_listing_url(
    subreddit: str,
    after: str | None = None,
) -> str:
    """Construct one Reddit new-listing URL."""
    url = (
        f"https://www.reddit.com/r/"
        f"{subreddit}/new.json"
        f"?limit={POSTS_PER_PAGE}"
        "&raw_json=1"
    )

    if after:
        url += (
            "&after="
            + quote(
                after,
                safe="",
            )
        )

    return url


def extract_posts(
    payload: dict[str, Any],
) -> tuple[
    list[dict[str, Any]],
    str | None,
]:
    """Extract posts and the next-page cursor."""
    data = payload.get(
        "data",
        {},
    )

    if not isinstance(data, dict):
        raise ValueError(
            "Listing data was not an object."
        )

    children = data.get(
        "children",
        [],
    )

    if not isinstance(children, list):
        raise ValueError(
            "Listing children was not a list."
        )

    posts = [
        child["data"]
        for child in children
        if (
            isinstance(child, dict)
            and isinstance(
                child.get("data"),
                dict,
            )
        )
    ]

    after = data.get("after")

    if (
        after is not None
        and not isinstance(after, str)
    ):
        after = str(after)

    return posts, after


# ---------------------------------------------------------------------------
# Authoritative-file helpers
# ---------------------------------------------------------------------------

def authoritative_paths(
    subreddit: str,
) -> tuple[Path, Path]:
    """Return authoritative CSV and JSON paths."""
    return (
        AUTHORITATIVE_DIR
        / f"auth_reddit_{subreddit}.csv",
        AUTHORITATIVE_DIR
        / f"auth_reddit_{subreddit}.json",
    )


def load_authoritative_pair(
    subreddit: str,
) -> tuple[
    dict[str, dict[str, str]],
    dict[str, dict[str, Any]],
    datetime,
]:
    """Load and validate an authoritative CSV/JSON pair."""
    csv_path, json_path = authoritative_paths(
        subreddit
    )

    if not csv_path.is_file():
        raise FileNotFoundError(
            f"Missing authoritative CSV: {csv_path}"
        )

    if not json_path.is_file():
        raise FileNotFoundError(
            f"Missing authoritative JSON: {json_path}"
        )

    csv_rows_by_id: dict[
        str,
        dict[str, str],
    ] = {}

    with csv_path.open(
        "r",
        newline="",
        encoding="utf-8-sig",
    ) as file:
        reader = csv.DictReader(file)

        available_fields = set(
            reader.fieldnames or []
        )

        missing_fields = (
            set(POST_FIELDS)
            - available_fields
        )

        if missing_fields:
            raise ValueError(
                f"{csv_path.name} is missing fields: "
                + ", ".join(
                    sorted(missing_fields)
                )
            )

        for row_number, row in enumerate(
            reader,
            start=2,
        ):
            post_id = (
                row.get("PostID")
                or ""
            ).strip()

            if not post_id:
                raise ValueError(
                    f"{csv_path.name} row "
                    f"{row_number} has no PostID."
                )

            if post_id in csv_rows_by_id:
                raise ValueError(
                    f"Duplicate PostID {post_id} "
                    f"in {csv_path.name}."
                )

            csv_rows_by_id[post_id] = row

    with json_path.open(
        "r",
        encoding="utf-8",
    ) as file:
        authoritative_json = json.load(file)

    children = (
        authoritative_json
        .get("data", {})
        .get("children", [])
    )

    if not isinstance(children, list):
        raise ValueError(
            f"{json_path.name} has invalid children."
        )

    json_posts_by_id: dict[
        str,
        dict[str, Any],
    ] = {}

    for child in children:
        if not isinstance(child, dict):
            continue

        post = child.get("data")

        if not isinstance(post, dict):
            continue

        post_id = post_key(post)

        if post_id in json_posts_by_id:
            raise ValueError(
                f"Duplicate PostID {post_id} "
                f"in {json_path.name}."
            )

        json_posts_by_id[post_id] = post

    csv_ids = set(csv_rows_by_id)
    json_ids = set(json_posts_by_id)

    if csv_ids != json_ids:
        only_csv = len(
            csv_ids - json_ids
        )

        only_json = len(
            json_ids - csv_ids
        )

        raise ValueError(
            "Authoritative CSV and JSON IDs "
            f"do not agree. CSV-only={only_csv}; "
            f"JSON-only={only_json}."
        )

    timestamps = [
        parse_utc(
            row["PostTimeUTC"]
        )
        for row in csv_rows_by_id.values()
        if (
            row.get("PostTimeUTC")
            or ""
        ).strip()
    ]

    if not timestamps:
        raise ValueError(
            f"{csv_path.name} contains no "
            "valid PostTimeUTC values."
        )

    latest_authoritative = max(
        timestamps
    )

    return (
        csv_rows_by_id,
        json_posts_by_id,
        latest_authoritative,
    )


def post_to_csv_row(
    post: dict[str, Any],
    run_timestamp: str,
) -> dict[str, Any]:
    """Flatten a new Reddit post for the authoritative CSV."""
    permalink = (
        post.get("permalink")
        or ""
    )

    post_url = (
        "https://www.reddit.com"
        + permalink
        if permalink
        else ""
    )

    created = post_datetime(post)

    return {
        "RunTimestampUTC":
            run_timestamp,
        "Subreddit":
            post.get("subreddit", ""),
        "PostID":
            post.get("id", ""),
        "Username":
            post.get("author", ""),
        "PostTimeUTC":
            utc_text(created)
            if created
            else "",
        "Title":
            post.get("title", ""),
        "SelfText":
            post.get("selftext", ""),
        "PostFlair":
            post.get("link_flair_text", ""),
        "Domain":
            post.get("domain", ""),
        "IsSelfPost":
            post.get("is_self", False),
        "NSFW":
            post.get("over_18", False),
        "Spoiler":
            post.get("spoiler", False),
        "Stickied":
            post.get("stickied", False),
        "Locked":
            post.get("locked", False),

        # The existing Votes column stores Reddit's ups value.
        "Votes":
            post.get("ups", 0),

        "UpvoteRatio":
            post.get("upvote_ratio", ""),
        "Comments":
            post.get("num_comments", 0),
        "ExternalURL": (
            post.get("url_overridden_by_dest")
            or post.get("url", "")
        ),
        "PostURL":
            post_url,
    }


# ---------------------------------------------------------------------------
# Daily collection
# ---------------------------------------------------------------------------

def collect_daily_window(
    driver: webdriver.Chrome,
    subreddit: str,
    refresh_boundary: datetime,
    authoritative_ids: set[str],
) -> dict[str, Any]:
    """Fetch pages until the refresh boundary is reached."""
    posts_by_id: dict[
        str,
        dict[str, Any],
    ] = {}

    known_overlap_ids: set[str] = set()
    source_pages: list[dict[str, Any]] = []

    after: str | None = None
    pages_completed = 0
    raw_posts_seen = 0

    boundary_reached = False
    pagination_exhausted = False

    oldest_fetched: datetime | None = None
    last_status: int | str = ""
    collection_error = ""

    for page_number in range(
        1,
        MAX_DAILY_PAGES + 1,
    ):
        url = build_listing_url(
            subreddit,
            after,
        )

        print(
            f"    Page {page_number}/"
            f"{MAX_DAILY_PAGES}"
        )

        try:
            last_status, payload = (
                visit_listing(
                    driver,
                    url,
                )
            )

            posts, returned_after = (
                extract_posts(payload)
            )

        except RuntimeError as exc:
            failed_status, failure_message = (
                parse_browser_error(exc)
            )

            last_status = (
                failed_status
                or last_status
            )

            collection_error = (
                f"Page {page_number} failed: "
                f"{failure_message}"
            )

            source_pages.append(
                {
                    "page_number":
                        page_number,
                    "request_url":
                        url,
                    "result":
                        "ERROR",
                    "error":
                        collection_error,
                }
            )

            print(
                f"        {collection_error}"
            )

            break

        raw_posts_seen += len(posts)
        pages_completed += 1

        for post in posts:
            post_id = post_key(post)

            posts_by_id[post_id] = post

            if post_id in authoritative_ids:
                known_overlap_ids.add(
                    post_id
                )

            created = post_datetime(post)

            if (
                created is not None
                and (
                    oldest_fetched is None
                    or created < oldest_fetched
                )
            ):
                oldest_fetched = created

        # Use non-stickied posts for the boundary test so an
        # old sticky cannot falsely end pagination.
        boundary_times = [
            created
            for post in posts
            if not post.get("stickied", False)
            if (
                created := post_datetime(post)
            ) is not None
        ]

        if not boundary_times:
            boundary_times = [
                created
                for post in posts
                if (
                    created := post_datetime(post)
                ) is not None
            ]

        page_oldest = (
            min(boundary_times)
            if boundary_times
            else None
        )

        source_pages.append(
            {
                "page_number":
                    page_number,
                "request_url":
                    url,
                "after_used":
                    after,
                "after_returned":
                    returned_after,
                "posts_returned":
                    len(posts),
                "unique_posts_collected":
                    len(posts_by_id),
                "known_overlap_posts":
                    len(known_overlap_ids),
                "oldest_page_post_utc": (
                    utc_text(page_oldest)
                    if page_oldest
                    else ""
                ),
                "result":
                    "SUCCESS",
            }
        )

        print(
            f"        Returned {len(posts)} posts; "
            f"unique={len(posts_by_id)}; "
            f"known overlap="
            f"{len(known_overlap_ids)}"
        )

        if (
            page_oldest is not None
            and page_oldest <= refresh_boundary
        ):
            boundary_reached = True

            print(
                "        Three-day refresh "
                "boundary reached."
            )

            break

        if not returned_after:
            pagination_exhausted = True

            print(
                "        Reddit returned no "
                "after cursor."
            )

            break

        after = returned_after

        if page_number < MAX_DAILY_PAGES:
            pause_seconds = random.uniform(
                *PAUSE_BETWEEN_PAGES
            )

            print(
                f"        Pausing "
                f"{pause_seconds:.1f} seconds..."
            )

            time.sleep(pause_seconds)

    overlap_confirmed = (
        bool(known_overlap_ids)
    )

    collection_complete = (
        not collection_error
        and overlap_confirmed
        and (
            boundary_reached
            or pagination_exhausted
        )
    )

    sorted_posts = sorted(
        posts_by_id.values(),
        key=lambda post: (
            float(
                post.get("created_utc")
                or 0
            )
        ),
        reverse=True,
    )

    return {
        "http_status":
            last_status,
        "posts":
            sorted_posts,
        "source_pages":
            source_pages,
        "pages_completed":
            pages_completed,
        "raw_posts_seen":
            raw_posts_seen,
        "unique_posts":
            len(sorted_posts),
        "known_overlap_posts":
            len(known_overlap_ids),
        "boundary_reached":
            boundary_reached,
        "pagination_exhausted":
            pagination_exhausted,
        "collection_complete":
            collection_complete,
        "collection_error":
            collection_error,
        "oldest_fetched_utc": (
            utc_text(oldest_fetched)
            if oldest_fetched
            else ""
        ),
    }


# ---------------------------------------------------------------------------
# Merge logic
# ---------------------------------------------------------------------------

def merge_daily_posts(
    csv_rows_by_id: dict[
        str,
        dict[str, Any],
    ],
    json_posts_by_id: dict[
        str,
        dict[str, Any],
    ],
    fetched_posts: list[
        dict[str, Any]
    ],
    run_timestamp: str,
    moderation_cutoff: datetime,
    refresh_boundary: datetime,
) -> dict[str, int]:
    """Merge new posts and update current engagement values."""
    new_posts_added = 0
    existing_posts_updated = 0

    comments_changed = 0
    votes_changed = 0
    ratio_changed = 0

    recent_posts_skipped = 0

    for fetched_post in fetched_posts:
        created = post_datetime(
            fetched_post
        )

        if created is None:
            continue

        # Do not add or refresh posts less than three hours old.
        if created > moderation_cutoff:
            recent_posts_skipped += 1
            continue

        post_id = post_key(
            fetched_post
        )

        # -----------------------------------------------------------
        # Add a previously unseen eligible post.
        # -----------------------------------------------------------

        if post_id not in csv_rows_by_id:
            csv_rows_by_id[post_id] = (
                post_to_csv_row(
                    fetched_post,
                    run_timestamp,
                )
            )

            json_posts_by_id[post_id] = dict(
                fetched_post
            )

            new_posts_added += 1
            continue

        # Only refresh engagement for posts inside the configured
        # three-day engagement window.
        if created < refresh_boundary:
            continue

        csv_row = csv_rows_by_id[
            post_id
        ]

        json_post = json_posts_by_id[
            post_id
        ]

        post_changed = False

        # num_comments -> Comments
        if (
            "num_comments" in fetched_post
            and fetched_post["num_comments"]
            is not None
        ):
            new_comments = parse_int(
                fetched_post["num_comments"]
            )

            old_csv_comments = parse_int(
                csv_row.get("Comments")
            )

            old_json_comments = parse_int(
                json_post.get("num_comments")
            )

            if (
                old_csv_comments != new_comments
                or old_json_comments
                != new_comments
            ):
                csv_row["Comments"] = (
                    new_comments
                )

                json_post["num_comments"] = (
                    new_comments
                )

                comments_changed += 1
                post_changed = True

        # ups -> Votes
        if (
            "ups" in fetched_post
            and fetched_post["ups"]
            is not None
        ):
            new_votes = parse_int(
                fetched_post["ups"]
            )

            old_csv_votes = parse_int(
                csv_row.get("Votes")
            )

            old_json_votes = parse_int(
                json_post.get("ups")
            )

            if (
                old_csv_votes != new_votes
                or old_json_votes != new_votes
            ):
                csv_row["Votes"] = (
                    new_votes
                )

                json_post["ups"] = (
                    new_votes
                )

                votes_changed += 1
                post_changed = True

        # upvote_ratio -> UpvoteRatio
        if (
            "upvote_ratio" in fetched_post
            and fetched_post["upvote_ratio"]
            is not None
        ):
            new_ratio = parse_float(
                fetched_post[
                    "upvote_ratio"
                ]
            )

            old_csv_ratio = parse_float(
                csv_row.get("UpvoteRatio")
            )

            old_json_ratio = parse_float(
                json_post.get(
                    "upvote_ratio"
                )
            )

            if (
                old_csv_ratio != new_ratio
                or old_json_ratio != new_ratio
            ):
                csv_row["UpvoteRatio"] = (
                    new_ratio
                )

                json_post["upvote_ratio"] = (
                    new_ratio
                )

                ratio_changed += 1
                post_changed = True

        if post_changed:
            existing_posts_updated += 1

    return {
        "new_posts_added":
            new_posts_added,
        "existing_posts_updated":
            existing_posts_updated,
        "comments_changed":
            comments_changed,
        "votes_changed":
            votes_changed,
        "upvote_ratio_changed":
            ratio_changed,
        "recent_posts_skipped":
            recent_posts_skipped,
    }


# ---------------------------------------------------------------------------
# File writing
# ---------------------------------------------------------------------------

def sorted_csv_rows(
    csv_rows_by_id: dict[
        str,
        dict[str, Any],
    ],
) -> list[dict[str, Any]]:
    """Return authoritative CSV rows newest first."""
    return sorted(
        csv_rows_by_id.values(),
        key=lambda row: (
            parse_utc(
                str(
                    row["PostTimeUTC"]
                )
            )
        ),
        reverse=True,
    )


def sorted_json_posts(
    json_posts_by_id: dict[
        str,
        dict[str, Any],
    ],
) -> list[dict[str, Any]]:
    """Return authoritative JSON posts newest first."""
    return sorted(
        json_posts_by_id.values(),
        key=lambda post: (
            float(
                post.get("created_utc")
                or 0
            )
        ),
        reverse=True,
    )


def build_authoritative_json(
    subreddit: str,
    run_timestamp: str,
    json_posts_by_id: dict[
        str,
        dict[str, Any],
    ],
    collection: dict[str, Any],
    merge_stats: dict[str, int],
) -> dict[str, Any]:
    """Build the current authoritative JSON document."""
    posts = sorted_json_posts(
        json_posts_by_id
    )

    created_values = [
        float(post["created_utc"])
        for post in posts
        if post.get("created_utc")
        is not None
    ]

    return {
        "kind":
            "AuthoritativeListing",
        "subreddit":
            subreddit,
        "authoritative_updated_utc":
            run_timestamp,
        "statistics": {
            "authoritative_posts":
                len(posts),
            "new_posts_added":
                merge_stats[
                    "new_posts_added"
                ],
            "existing_posts_updated":
                merge_stats[
                    "existing_posts_updated"
                ],
            "comments_changed":
                merge_stats[
                    "comments_changed"
                ],
            "votes_changed":
                merge_stats[
                    "votes_changed"
                ],
            "upvote_ratio_changed":
                merge_stats[
                    "upvote_ratio_changed"
                ],
            "recent_posts_skipped":
                merge_stats[
                    "recent_posts_skipped"
                ],
            "pages_completed":
                collection[
                    "pages_completed"
                ],
            "known_overlap_posts":
                collection[
                    "known_overlap_posts"
                ],
            "oldest_post_utc": (
                utc_text(
                    min(created_values)
                )
                if created_values
                else ""
            ),
            "latest_post_utc": (
                utc_text(
                    max(created_values)
                )
                if created_values
                else ""
            ),
        },
        "last_daily_collection": {
            "source_pages":
                collection[
                    "source_pages"
                ],
            "oldest_fetched_utc":
                collection[
                    "oldest_fetched_utc"
                ],
            "boundary_reached":
                collection[
                    "boundary_reached"
                ],
            "pagination_exhausted":
                collection[
                    "pagination_exhausted"
                ],
        },
        "data": {
            "dist":
                len(posts),
            "children": [
                {
                    "kind": "t3",
                    "data": post,
                }
                for post in posts
            ],
        },
    }


def write_daily_staging_files(
    run_folder: Path,
    subreddit: str,
    folder_timestamp: str,
    run_timestamp: str,
    collection: dict[str, Any],
) -> tuple[Path, Path]:
    """Save all posts fetched during the daily run."""
    csv_path = (
        run_folder
        / (
            f"daily_reddit_{subreddit}_"
            f"{folder_timestamp}.csv"
        )
    )

    json_path = (
        run_folder
        / (
            f"daily_reddit_{subreddit}_"
            f"{folder_timestamp}.json"
        )
    )

    rows = [
        post_to_csv_row(
            post,
            run_timestamp,
        )
        for post in collection["posts"]
    ]

    with csv_path.open(
        "w",
        newline="",
        encoding="utf-8-sig",
    ) as file:
        writer = csv.DictWriter(
            file,
            fieldnames=POST_FIELDS,
            extrasaction="ignore",
        )

        writer.writeheader()
        writer.writerows(rows)

    payload = {
        "kind":
            "DailyFetchedListing",
        "subreddit":
            subreddit,
        "run_timestamp_utc":
            run_timestamp,
        "collection": {
            key: value
            for key, value
            in collection.items()
            if key != "posts"
        },
        "data": {
            "dist":
                len(collection["posts"]),
            "children": [
                {
                    "kind": "t3",
                    "data": post,
                }
                for post
                in collection["posts"]
            ],
        },
    }

    with json_path.open(
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            payload,
            file,
            ensure_ascii=False,
            indent=2,
        )

    return csv_path, json_path


def commit_authoritative_pair(
    subreddit: str,
    csv_rows_by_id: dict[
        str,
        dict[str, Any],
    ],
    authoritative_json: dict[str, Any],
    backup_folder: Path,
) -> None:
    """Back up and atomically replace an authoritative pair."""
    csv_path, json_path = authoritative_paths(
        subreddit
    )

    csv_temp = csv_path.with_suffix(
        ".csv.tmp"
    )

    json_temp = json_path.with_suffix(
        ".json.tmp"
    )

    backup_csv_path = (
        backup_folder
        / csv_path.name
    )

    backup_json_path = (
        backup_folder
        / json_path.name
    )

    backup_csv_temp = (
        backup_folder
        / f"{csv_path.name}.tmp"
    )

    backup_json_temp = (
        backup_folder
        / f"{json_path.name}.tmp"
    )

    try:
        rows = sorted_csv_rows(
            csv_rows_by_id
        )

        with csv_temp.open(
            "w",
            newline="",
            encoding="utf-8-sig",
        ) as file:
            writer = csv.DictWriter(
                file,
                fieldnames=POST_FIELDS,
                extrasaction="ignore",
            )

            writer.writeheader()
            writer.writerows(rows)

        with json_temp.open(
            "w",
            encoding="utf-8",
        ) as file:
            json.dump(
                authoritative_json,
                file,
                ensure_ascii=False,
                indent=2,
            )

        # Validate temporary CSV IDs.
        with csv_temp.open(
            "r",
            newline="",
            encoding="utf-8-sig",
        ) as file:
            temp_csv_ids = {
                row["PostID"]
                for row
                in csv.DictReader(file)
            }

        temp_children = (
            authoritative_json
            .get("data", {})
            .get("children", [])
        )

        temp_json_ids = {
            post_key(child["data"])
            for child in temp_children
            if (
                isinstance(child, dict)
                and isinstance(
                    child.get("data"),
                    dict,
                )
            )
        }

        if temp_csv_ids != temp_json_ids:
            raise ValueError(
                "Temporary authoritative CSV "
                "and JSON IDs do not match."
            )

        backup_folder.mkdir(
            parents=True,
            exist_ok=True,
        )

        # Copy into temporary backup files first. This prevents an
        # interrupted copy from damaging the existing backup file.
        shutil.copy2(
            csv_path,
            backup_csv_temp,
        )

        shutil.copy2(
            json_path,
            backup_json_temp,
        )

        # Atomically replace the previous backup files.
        backup_csv_temp.replace(
            backup_csv_path
        )

        backup_json_temp.replace(
            backup_json_path
        )

        csv_temp.replace(csv_path)
        json_temp.replace(json_path)

    finally:
        if csv_temp.exists():
            csv_temp.unlink()

        if json_temp.exists():
            json_temp.unlink()

        if backup_csv_temp.exists():
            backup_csv_temp.unlink()

        if backup_json_temp.exists():
            backup_json_temp.unlink()

# ---------------------------------------------------------------------------
# Lock file
# ---------------------------------------------------------------------------

def acquire_lock(
    run_timestamp: str,
) -> None:
    """Prevent two daily runs from executing simultaneously."""
    MULTIPLE_SUBS_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    try:
        descriptor = os.open(
            str(LOCK_PATH),
            os.O_CREAT
            | os.O_EXCL
            | os.O_WRONLY,
        )

    except FileExistsError as exc:
        raise RuntimeError(
            "Another daily scraper may already "
            f"be running. Lock file: {LOCK_PATH}"
        ) from exc

    with os.fdopen(
        descriptor,
        "w",
        encoding="utf-8",
    ) as file:
        file.write(
            f"Started: {run_timestamp}\n"
        )

        file.write(
            f"Process ID: {os.getpid()}\n"
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_collection() -> dict[str, Any]:
    run_started = datetime.now(
        timezone.utc
    )

    run_timestamp = utc_text(
        run_started
    )

    folder_timestamp = (
        run_started.strftime(
            "%Y%m%d_%H%M%S"
        )
        + (
            f"{run_started.microsecond // 10_000:02d}"
        )
        + "_UTC"
    )

    moderation_cutoff = (
        run_started
        - timedelta(
            hours=MODERATION_DELAY_HOURS
        )
    )

    run_folder = (
        DAILY_RUNS_DIR
        / f"daily_{folder_timestamp}"
    )

    backup_folder = (
        BACKUP_ROOT_DIR
        / "latest"
    )

    run_log_path = (
        run_folder
        / "daily_log.csv"
    )

    AUTHORITATIVE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    DAILY_RUNS_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    run_folder.mkdir(
        parents=True,
        exist_ok=False,
    )

    acquire_lock(run_timestamp)

    driver: webdriver.Chrome | None = None

    successful = 0
    partial = 0
    failed = 0

    print(f"Run timestamp: {run_timestamp}")
    print(f"Moderation cutoff: {utc_text(moderation_cutoff)}")
    print(f"Run folder: {run_folder}")
    print(f"Subreddits: {len(SUBREDDITS)}")
    print("Opening Chrome...\n")

    try:
        driver = create_chrome_driver()

        for index, subreddit in enumerate(
            SUBREDDITS,
            start=1,
        ):
            subreddit_started = (
                time.monotonic()
            )

            result = "ERROR"
            message = ""
            http_status: int | str = ""

            pages_completed = 0
            posts_fetched = 0
            known_overlap = 0

            rows_before = 0
            rows_after = 0

            latest_authoritative_text = ""
            refresh_boundary_text = ""
            oldest_fetched_text = ""

            merge_stats = {
                "new_posts_added": 0,
                "existing_posts_updated": 0,
                "comments_changed": 0,
                "votes_changed": 0,
                "upvote_ratio_changed": 0,
                "recent_posts_skipped": 0,
            }

            authoritative_csv_path, authoritative_json_path = (
                authoritative_paths(subreddit)
            )

            print(
                f"[{index}/{len(SUBREDDITS)}] "
                f"Processing r/{subreddit}..."
            )

            try:
                (
                    csv_rows_by_id,
                    json_posts_by_id,
                    latest_authoritative,
                ) = load_authoritative_pair(
                    subreddit
                )

                rows_before = len(
                    csv_rows_by_id
                )

                latest_authoritative_text = (
                    utc_text(
                        latest_authoritative
                    )
                )

                refresh_boundary = (
                    latest_authoritative
                    - timedelta(
                        days=ENGAGEMENT_REFRESH_DAYS
                    )
                )

                refresh_boundary_text = (
                    utc_text(
                        refresh_boundary
                    )
                )

                print(
                    f"    Latest authoritative post: "
                    f"{latest_authoritative_text}"
                )

                print(
                    f"    Engagement refresh boundary: "
                    f"{refresh_boundary_text}"
                )

                collection = collect_daily_window(
                    driver,
                    subreddit,
                    refresh_boundary,
                    set(csv_rows_by_id),
                )

                http_status = collection[
                    "http_status"
                ]

                pages_completed = collection[
                    "pages_completed"
                ]

                posts_fetched = collection[
                    "unique_posts"
                ]

                known_overlap = collection[
                    "known_overlap_posts"
                ]

                oldest_fetched_text = collection[
                    "oldest_fetched_utc"
                ]

                write_daily_staging_files(
                    run_folder,
                    subreddit,
                    folder_timestamp,
                    run_timestamp,
                    collection,
                )

                if not collection[
                    "collection_complete"
                ]:
                    result = "PARTIAL"
                    partial += 1

                    message = (
                        collection[
                            "collection_error"
                        ]
                        or (
                            "Required overlap was not "
                            "established before the "
                            "daily page limit."
                        )
                    )

                    print(
                        "    PARTIAL: authoritative "
                        "files were not changed."
                    )

                else:
                    merge_stats = merge_daily_posts(
                        csv_rows_by_id,
                        json_posts_by_id,
                        collection["posts"],
                        run_timestamp,
                        moderation_cutoff,
                        refresh_boundary,
                    )

                    rows_after = len(
                        csv_rows_by_id
                    )

                    changes_made = (
                        merge_stats[
                            "new_posts_added"
                        ]
                        > 0
                        or merge_stats[
                            "existing_posts_updated"
                        ]
                        > 0
                    )

                    if changes_made:
                        authoritative_json = (
                            build_authoritative_json(
                                subreddit,
                                run_timestamp,
                                json_posts_by_id,
                                collection,
                                merge_stats,
                            )
                        )

                        commit_authoritative_pair(
                            subreddit,
                            csv_rows_by_id,
                            authoritative_json,
                            backup_folder,
                        )

                    result = "SUCCESS"
                    successful += 1

                    message = (
                        f"New={merge_stats['new_posts_added']}; "
                        f"updated="
                        f"{merge_stats['existing_posts_updated']}; "
                        f"comments_changed="
                        f"{merge_stats['comments_changed']}; "
                        f"votes_changed="
                        f"{merge_stats['votes_changed']}; "
                        f"ratio_changed="
                        f"{merge_stats['upvote_ratio_changed']}; "
                        f"recent_skipped="
                        f"{merge_stats['recent_posts_skipped']}"
                    )

                    print(f"    SUCCESS: {message}")

            except Exception as exc:
                result = "ERROR"
                failed += 1

                message = (
                    f"{type(exc).__name__}: {exc}"
                )

                print(
                    f"    ERROR: {message}"
                )

            finally:
                elapsed = (
                    time.monotonic()
                    - subreddit_started
                )

                log_row = {
                    "RunTimestampUTC":
                        run_timestamp,
                    "Subreddit":
                        subreddit,
                    "Result":
                        result,
                    "HTTPStatus":
                        http_status,
                    "PagesCompleted":
                        pages_completed,
                    "PostsFetched":
                        posts_fetched,
                    "KnownOverlapPosts":
                        known_overlap,
                    "NewPostsAdded":
                        merge_stats[
                            "new_posts_added"
                        ],
                    "ExistingPostsUpdated":
                        merge_stats[
                            "existing_posts_updated"
                        ],
                    "CommentsChanged":
                        merge_stats[
                            "comments_changed"
                        ],
                    "VotesChanged":
                        merge_stats[
                            "votes_changed"
                        ],
                    "UpvoteRatioChanged":
                        merge_stats[
                            "upvote_ratio_changed"
                        ],
                    "RecentPostsSkipped":
                        merge_stats[
                            "recent_posts_skipped"
                        ],
                    "AuthoritativeRowsBefore":
                        rows_before,
                    "AuthoritativeRowsAfter":
                        rows_after,
                    "LatestAuthoritativePostUTC":
                        latest_authoritative_text,
                    "RefreshBoundaryUTC":
                        refresh_boundary_text,
                    "ModerationCutoffUTC":
                        utc_text(
                            moderation_cutoff
                        ),
                    "OldestFetchedPostUTC":
                        oldest_fetched_text,
                    "AuthoritativeCSV":
                        str(
                            authoritative_csv_path
                        ),
                    "AuthoritativeJSON":
                        str(
                            authoritative_json_path
                        ),
                    "ElapsedSeconds":
                        f"{elapsed:.2f}",
                    "Message":
                        message,
                }

                append_log(
                    run_log_path,
                    log_row,
                )

                append_log(
                    MASTER_LOG_PATH,
                    log_row,
                )

            if index < len(SUBREDDITS):
                if http_status == 429:
                    pause_seconds = (
                        RATE_LIMIT_COOLDOWN_SECONDS
                    )

                    print(
                        f"    HTTP 429 cooldown: "
                        f"{pause_seconds} seconds.\n"
                    )
                else:
                    pause_seconds = random.uniform(
                        *PAUSE_BETWEEN_SUBREDDITS
                    )

                    print(
                        f"    Pausing "
                        f"{pause_seconds:.1f} seconds.\n"
                    )

                time.sleep(pause_seconds)

    finally:
        if driver is not None:
            print("\nClosing Chrome...")

            try:
                driver.quit()
            except WebDriverException:
                pass

        if LOCK_PATH.exists():
            LOCK_PATH.unlink()

    print("\nFinished.")
    print(
        f"Successful subreddits: "
        f"{successful}/{len(SUBREDDITS)}"
    )
    print(
        f"Partial subreddits: "
        f"{partial}/{len(SUBREDDITS)}"
    )
    print(
        f"Failed subreddits: "
        f"{failed}/{len(SUBREDDITS)}"
    )
    print(f"Run folder: {run_folder}")
    print(f"Run log: {run_log_path}")
    print(f"Master log: {MASTER_LOG_PATH}")

    return {
        "successful": successful,
        "partial": partial,
        "failed": failed,
        "total": len(SUBREDDITS),
        "run_folder": run_folder,
        "run_log_path": run_log_path,
    }


def main() -> None:
    """Run the standalone public collector without private integrations."""
    summary = run_collection()

    if (
        summary["successful"] != summary["total"]
        or summary["partial"] != 0
        or summary["failed"] != 0
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
