import assert from "node:assert/strict";
import test from "node:test";

import { handleIceBreakerMessage } from "../api/webhook.js";

function navigationServices(calls) {
  return {
    sendMainMenu: async (to) => calls.push(["main", to]),
    sendActiveRequestNavigation: async (to) => calls.push(["active", to]),
  };
}

test("Ice Breaker shows the main menu for a new user without creating state", async () => {
  const calls = [];

  assert.equal(await handleIceBreakerMessage("new-user", "Розпочати розмову", null, navigationServices(calls)), true);
  assert.deepEqual(calls, [["main", "new-user"]]);
});

test("Ice Breaker shows the main menu for a returning user without an active request", async () => {
  const state = { stage: "MAIN_MENU", request: { data: { phone: "returning-user" } } };
  const snapshot = structuredClone(state);
  const calls = [];

  assert.equal(await handleIceBreakerMessage("returning-user", "  РОЗПОЧАТИ   РОЗМОВУ  ", state, navigationServices(calls)), true);
  assert.deepEqual(calls, [["main", "returning-user"]]);
  assert.deepEqual(state, snapshot);
});

test("Ice Breaker shows active-request navigation without changing request state", async () => {
  const state = {
    stage: "DOCUMENTS",
    request: { type: "individual", data: { phone: "active-user", name: "Test" }, documents: {}, documentIndex: 0 },
  };
  const snapshot = structuredClone(state);
  const calls = [];

  assert.equal(await handleIceBreakerMessage("active-user", " розпочати  РОЗМОВУ ", state, navigationServices(calls)), true);
  assert.deepEqual(calls, [["active", "active-user"]]);
  assert.deepEqual(state, snapshot);
});

test("other text is ignored by the Ice Breaker handler", async () => {
  const calls = [];

  assert.equal(await handleIceBreakerMessage("user", "Розпочати заявку", null, navigationServices(calls)), false);
  assert.deepEqual(calls, []);
});
