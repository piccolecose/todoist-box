const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const github = require("@actions/github");

const indexPath = require.resolve("../index.js");
const envKeys = [
  "GIST_ID",
  "GH_TOKEN",
  "TODOIST_AUTH_CODE",
  "TODOIST_REDIRECT_URI",
  "TODOIST_API_KEY",
  "TODOIST_PERSONAL_TOKEN",
  "TODOIST_CLIENT_ID",
  "TODOIST_CLIENT_SECRET",
];
const baseEnv = {
  GIST_ID: "gist1",
  GH_TOKEN: "ghp_token",
  TODOIST_CLIENT_ID: "client-id",
  TODOIST_CLIENT_SECRET: "client-secret",
};

function loadIndex(env = {}) {
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[indexPath];
  return require(indexPath);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function dayOffset(offset) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().substring(0, 10);
}

function activities(offsets, nextCursor = null) {
  return {
    results: offsets.map((offset) => ({
      event_date: `${dayOffset(offset)}T10:00:00.000000Z`,
    })),
    next_cursor: nextCursor,
  };
}

let fetchMock;

beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
  fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected fetch call");
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const key of envKeys) delete process.env[key];
});

describe("assertRequiredEnv", () => {
  test("lists every missing variable", () => {
    const { assertRequiredEnv } = loadIndex();
    assert.throws(
      assertRequiredEnv,
      /Missing required environment variables: GIST_ID, GH_TOKEN, TODOIST_CLIENT_ID, TODOIST_CLIENT_SECRET/,
    );
  });

  test("lists only the variables that are missing", () => {
    const { assertRequiredEnv } = loadIndex({ GIST_ID: "g", GH_TOKEN: "t" });
    assert.throws(
      assertRequiredEnv,
      /variables: TODOIST_CLIENT_ID, TODOIST_CLIENT_SECRET$/,
    );
  });

  test("passes when all are set", () => {
    const { assertRequiredEnv } = loadIndex(baseEnv);
    assert.doesNotThrow(assertRequiredEnv);
  });
});

describe("getTodoistAccessToken", () => {
  for (const name of ["TODOIST_API_KEY", "TODOIST_PERSONAL_TOKEN"]) {
    test(`migrates the personal token from ${name}`, async () => {
      const { getTodoistAccessToken } = loadIndex({
        ...baseEnv,
        [name]: "personal",
        TODOIST_AUTH_CODE: "ignored-code",
      });
      fetchMock.mock.mockImplementation(async () =>
        jsonResponse({ access_token: "migrated" }),
      );

      assert.strictEqual(await getTodoistAccessToken(), "migrated");

      assert.strictEqual(fetchMock.mock.callCount(), 1);
      const [url, init] = fetchMock.mock.calls[0].arguments;
      assert.strictEqual(
        url,
        "https://api.todoist.com/api/v1/access_tokens/migrate_personal_token",
      );
      assert.strictEqual(init.method, "POST");
      assert.deepStrictEqual(JSON.parse(init.body), {
        client_id: "client-id",
        client_secret: "client-secret",
        personal_token: "personal",
        scope: "data:read",
      });
    });
  }

  test("throws when migration is rejected", async () => {
    const { getTodoistAccessToken } = loadIndex({
      ...baseEnv,
      TODOIST_API_KEY: "personal",
    });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ error: "bad" }, 401),
    );
    await assert.rejects(
      getTodoistAccessToken,
      /Failed to migrate token \(401\): {"error":"bad"}/,
    );
  });

  test("exchanges the OAuth code without redirect_uri when unset", async () => {
    const { getTodoistAccessToken } = loadIndex({
      ...baseEnv,
      TODOIST_AUTH_CODE: "the-code",
    });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ access_token: "oauth" }),
    );

    assert.strictEqual(await getTodoistAccessToken(), "oauth");

    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.strictEqual(url, "https://api.todoist.com/oauth/access_token");
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(
      init.headers["Content-Type"],
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(init.body);
    assert.strictEqual(body.get("client_id"), "client-id");
    assert.strictEqual(body.get("client_secret"), "client-secret");
    assert.strictEqual(body.get("code"), "the-code");
    assert.strictEqual(body.has("redirect_uri"), false);
  });

  test("appends redirect_uri when set", async () => {
    const { getTodoistAccessToken } = loadIndex({
      ...baseEnv,
      TODOIST_AUTH_CODE: "the-code",
      TODOIST_REDIRECT_URI: "https://example.com/cb",
    });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ access_token: "oauth" }),
    );

    await getTodoistAccessToken();

    const body = new URLSearchParams(fetchMock.mock.calls[0].arguments[1].body);
    assert.strictEqual(body.get("redirect_uri"), "https://example.com/cb");
  });

  test("throws when the OAuth exchange is not ok", async () => {
    const { getTodoistAccessToken } = loadIndex({
      ...baseEnv,
      TODOIST_AUTH_CODE: "the-code",
    });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ error: "invalid_grant" }, 400),
    );
    await assert.rejects(
      getTodoistAccessToken,
      /Failed to exchange OAuth code \(400\)/,
    );
  });

  test("throws when the OAuth response has no access_token", async () => {
    const { getTodoistAccessToken } = loadIndex({
      ...baseEnv,
      TODOIST_AUTH_CODE: "the-code",
    });
    fetchMock.mock.mockImplementation(async () => jsonResponse({}));
    await assert.rejects(
      getTodoistAccessToken,
      /Failed to exchange OAuth code \(200\)/,
    );
  });

  test("throws when no Todoist auth is configured", async () => {
    const { getTodoistAccessToken } = loadIndex(baseEnv);
    await assert.rejects(getTodoistAccessToken, /Missing Todoist auth/);
    assert.strictEqual(fetchMock.mock.callCount(), 0);
  });
});

describe("daysBetween", () => {
  test("counts whole days in either direction", () => {
    const { daysBetween } = loadIndex(baseEnv);
    assert.strictEqual(daysBetween("2024-03-01", "2024-03-01"), 0);
    assert.strictEqual(daysBetween("2024-03-01", "2024-03-02"), 1);
    assert.strictEqual(daysBetween("2024-03-05", "2024-03-01"), 4);
  });

  test("counts across a leap day", () => {
    const { daysBetween } = loadIndex(baseEnv);
    assert.strictEqual(daysBetween("2024-02-28", "2024-03-01"), 2);
  });
});

describe("calculateStreak", () => {
  test("is 0 for no dates", () => {
    const { calculateStreak } = loadIndex(baseEnv);
    assert.strictEqual(calculateStreak([]), 0);
  });

  test("is 1 for today only", () => {
    const { calculateStreak } = loadIndex(baseEnv);
    assert.strictEqual(calculateStreak([dayOffset(0)]), 1);
  });

  test("is 1 for yesterday only", () => {
    const { calculateStreak } = loadIndex(baseEnv);
    assert.strictEqual(calculateStreak([dayOffset(-1)]), 1);
  });

  test("counts consecutive days ending today", () => {
    const { calculateStreak } = loadIndex(baseEnv);
    const dates = [dayOffset(0), dayOffset(-1), dayOffset(-2)];
    assert.strictEqual(calculateStreak(dates), 3);
  });

  test("stops at the first gap", () => {
    const { calculateStreak } = loadIndex(baseEnv);
    const dates = [dayOffset(0), dayOffset(-1), dayOffset(-3), dayOffset(-4)];
    assert.strictEqual(calculateStreak(dates), 2);
  });

  test("is 0 when the latest day is older than yesterday", () => {
    const { calculateStreak } = loadIndex(baseEnv);
    assert.strictEqual(calculateStreak([dayOffset(-2), dayOffset(-3)]), 0);
  });
});

describe("fetchStreakDays", () => {
  test("sends the bearer token to the activities endpoint", async () => {
    const { fetchStreakDays } = loadIndex(baseEnv);
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(activities([0])),
    );

    assert.strictEqual(await fetchStreakDays("tok"), 1);

    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.strictEqual(
      url,
      "https://api.todoist.com/api/v1/activities?event_type=completed&limit=100",
    );
    assert.strictEqual(init.headers.Authorization, "Bearer tok");
  });

  test("follows next_cursor while the streak is unbroken", async () => {
    const { fetchStreakDays } = loadIndex(baseEnv);
    const pages = [
      activities([0, -1], "c1"),
      activities([-2, -3], "c2"),
      activities([-4]),
    ];
    fetchMock.mock.mockImplementation(async () => jsonResponse(pages.shift()));

    assert.strictEqual(await fetchStreakDays("tok"), 5);

    assert.strictEqual(fetchMock.mock.callCount(), 3);
    assert.match(fetchMock.mock.calls[1].arguments[0], /&cursor=c1$/);
    assert.match(fetchMock.mock.calls[2].arguments[0], /&cursor=c2$/);
  });

  test("stops paging once the streak is broken", async () => {
    const { fetchStreakDays } = loadIndex(baseEnv);
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(activities([0, -1, -5], "more")),
    );

    assert.strictEqual(await fetchStreakDays("tok"), 2);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  test("is 0 without further paging when the latest day is stale", async () => {
    const { fetchStreakDays } = loadIndex(baseEnv);
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(activities([-4, -5], "more")),
    );

    assert.strictEqual(await fetchStreakDays("tok"), 0);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  test("is 0 when the response is not ok", async () => {
    const { fetchStreakDays } = loadIndex(baseEnv);
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ error: "nope" }, 500),
    );

    assert.strictEqual(await fetchStreakDays("tok"), 0);
  });
});

describe("fetchData", () => {
  const syncBody = {
    user: { karma: 1234.5 },
    stats: {
      completed_count: 99,
      days_items: [{ total_completed: 3 }],
      week_items: [{ total_completed: 12 }],
    },
  };

  function routeFetch(syncResponse) {
    fetchMock.mock.mockImplementation(async (url) =>
      String(url).includes("/activities")
        ? jsonResponse(activities([0, -1]))
        : syncResponse,
    );
  }

  test("maps sync fields and the streak", async () => {
    const { fetchData } = loadIndex(baseEnv);
    routeFetch(jsonResponse(syncBody));

    assert.deepStrictEqual(await fetchData("tok"), {
      karma: 1234.5,
      completed_count: 99,
      days_items: syncBody.stats.days_items,
      week_items: syncBody.stats.week_items,
      streak: 2,
    });

    const syncCall = fetchMock.mock.calls.find(
      (call) => call.arguments[0] === "https://api.todoist.com/api/v1/sync",
    );
    assert.strictEqual(syncCall.arguments[1].method, "POST");
    assert.strictEqual(
      syncCall.arguments[1].headers.Authorization,
      "Bearer tok",
    );
    assert.strictEqual(
      syncCall.arguments[1].body,
      'sync_token=*&resource_types=["user","stats"]',
    );
  });

  test("throws when the sync response is not ok", async () => {
    const { fetchData } = loadIndex(baseEnv);
    routeFetch(jsonResponse({ error: "denied" }, 403));

    await assert.rejects(
      () => fetchData("tok"),
      /Failed to fetch sync data \(403\)/,
    );
  });
});

describe("updateGist", () => {
  const data = {
    karma: 12345,
    completed_count: 6789,
    days_items: [{ total_completed: 4 }],
    week_items: [{ total_completed: 21 }],
    streak: 1500,
  };

  function stubOctokit({ get, update }) {
    const octokit = { rest: { gists: { get, update } } };
    const getOctokit = mock.method(github, "getOctokit", () => octokit);
    return getOctokit;
  }

  test("updates the first gist file with the five stat lines", async () => {
    const get = mock.fn(async () => ({
      data: { files: { "first.md": {}, "second.md": {} } },
    }));
    const update = mock.fn(async () => ({}));
    const getOctokit = stubOctokit({ get, update });
    const { updateGist } = loadIndex(baseEnv);

    await updateGist(data);

    assert.deepStrictEqual(getOctokit.mock.calls[0].arguments, ["ghp_token"]);
    assert.deepStrictEqual(get.mock.calls[0].arguments, [{ gist_id: "gist1" }]);
    assert.deepStrictEqual(update.mock.calls[0].arguments, [
      {
        gist_id: "gist1",
        files: {
          "first.md": {
            filename: "✅ Todoist Stats",
            content: [
              "🏆 12,345 Karma Points",
              "🌞 Completed 4 tasks today",
              "📅 Completed 21 tasks this week",
              "✅ Completed 6,789 tasks so far",
              "⌛ Current streak is 1,500 days",
            ].join("\n"),
          },
        },
      },
    ]);
  });

  test("throws when the gist cannot be fetched", async () => {
    const update = mock.fn();
    stubOctokit({
      get: async () => {
        throw new Error("404");
      },
      update,
    });
    const { updateGist } = loadIndex(baseEnv);

    await assert.rejects(() => updateGist(data), /^Error: Unable to get gist$/);
    assert.strictEqual(update.mock.callCount(), 0);
  });

  test("throws when the gist cannot be updated", async () => {
    stubOctokit({
      get: async () => ({ data: { files: { "a.md": {} } } }),
      update: async () => {
        throw new Error("500");
      },
    });
    const { updateGist } = loadIndex(baseEnv);

    await assert.rejects(
      () => updateGist(data),
      /^Error: Unable to update gist$/,
    );
  });
});

describe("main", () => {
  test("fetches a token, stats, and updates the gist", async () => {
    const update = mock.fn(async () => ({}));
    mock.method(github, "getOctokit", () => ({
      rest: {
        gists: {
          get: async () => ({ data: { files: { "a.md": {} } } }),
          update,
        },
      },
    }));
    const { main } = loadIndex({ ...baseEnv, TODOIST_API_KEY: "personal" });
    fetchMock.mock.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("migrate_personal_token"))
        return jsonResponse({ access_token: "tok" });
      if (href.includes("/activities")) return jsonResponse(activities([0]));
      return jsonResponse({
        user: { karma: 1 },
        stats: {
          completed_count: 2,
          days_items: [{ total_completed: 3 }],
          week_items: [{ total_completed: 4 }],
        },
      });
    });

    await main();

    assert.strictEqual(update.mock.callCount(), 1);
    assert.match(
      update.mock.calls[0].arguments[0].files["a.md"].content,
      /Current streak is 1 days/,
    );
  });

  test("fails fast when env is missing", async () => {
    const { main } = loadIndex();
    await assert.rejects(main, /Missing required environment variables/);
    assert.strictEqual(fetchMock.mock.callCount(), 0);
  });
});
