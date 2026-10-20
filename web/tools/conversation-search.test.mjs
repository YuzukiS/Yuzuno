import test from "node:test";
import assert from "node:assert/strict";
import { searchConversation } from "../src/conversation-search.ts";

const turns = [
  {
    id: "t1",
    status: "completed",
    items: [
      {
        id: "u",
        type: "userMessage",
        content: [{ type: "text", text: "用户说：检查中文 SearchToken" }],
      },
      {
        id: "p",
        type: "agentMessage",
        phase: "commentary",
        text: "Checking searchtoken now.",
      },
      {
        id: "r",
        type: "agentMessage",
        phase: "final_answer",
        text: "SEARCHTOKEN finished; SearchToken repeated.",
      },
      {
        id: "tool",
        type: "commandExecution",
        aggregatedOutput: "SearchToken tool-only",
      },
      { id: "reason", type: "reasoning", text: "SearchToken reasoning-only" },
      {
        id: "file",
        type: "fileChange",
        changes: [{ path: "SearchToken", diff: "SearchToken" }],
      },
    ],
  },
  {
    id: "t2",
    status: "inProgress",
    items: [
      {
        id: "r",
        type: "agentMessage",
        text: "Another SearchToken reply with the same item ID.",
      },
    ],
  },
];

test("matches loaded user, progress and reply messages once each, case-insensitively", () => {
  const matches = searchConversation(turns, "  sEaRcHtOkEn  ");
  assert.deepEqual(
    matches.map(({ turnId, itemId, role, turnNumber }) => [
      turnId,
      itemId,
      role,
      turnNumber,
    ]),
    [
      ["t1", "u", "user", 1],
      ["t1", "p", "progress", 1],
      ["t1", "r", "assistant", 1],
      ["t2", "r", "assistant", 2],
    ],
  );
  assert.equal(matches[2].match, "SEARCHTOKEN");
  assert.equal(searchConversation(turns, "tool-only").length, 0);
  assert.equal(searchConversation(turns, "reasoning-only").length, 0);
});

test("supports Chinese, empty queries, no matches, and literal punctuation", () => {
  assert.equal(searchConversation(turns, "检查中文")[0].itemId, "u");
  for (const query of ["", " \n ", "missing phrase", "[.*]"]) {
    assert.deepEqual(searchConversation(turns, query), []);
  }
  const literal = [
    {
      id: "t",
      status: "completed",
      items: [
        {
          id: "m",
          type: "agentMessage",
          text: "Literal a+b [x] (y)? .* $ \\ expression",
        },
      ],
    },
  ];
  assert.equal(
    searchConversation(literal, "a+b [x] (y)? .* $ \\")[0].match,
    "a+b [x] (y)? .* $ \\",
  );
  assert.deepEqual(searchConversation([], "SearchToken"), []);
});

test("snippets include the actual matching text and bounded surrounding context", () => {
  const result = searchConversation(
    [
      {
        id: "t",
        status: "completed",
        items: [
          {
            id: "m",
            type: "agentMessage",
            text: "前".repeat(200) + "TARGET" + "后".repeat(300),
          },
        ],
      },
    ],
    "target",
  )[0];
  assert.equal(result.before, "…" + "前".repeat(60));
  assert.equal(result.match, "TARGET");
  assert.equal(result.after, "后".repeat(120) + "…");
});
