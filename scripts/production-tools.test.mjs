import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";

function mockAuphonic(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, { method, body }) => {
    const call = { url, method, body: body && JSON.parse(body) };
    calls.push(call);
    return Response.json({ status_code: 200, data: respond(call) });
  });
  return calls;
}

async function call(name, args = {}, errorCode) {
  const response = await worker.fetch(new Request("https://mcp.example/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), { AUPHONIC_API_KEY: "test-key" });
  const { result } = await response.json();
  assert.equal(result.structuredContent.error?.code, errorCode, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

test("list_productions filters the requested page even if Auphonic returns mixed statuses", async (t) => {
  const calls = mockAuphonic(t, ({ url }) => url.searchParams.get("offset") === "4"
    ? [{ uuid: "draft", status: 10 }, { uuid: "done", status: 3 }]
    : url.searchParams.get("offset") === "6" ? [{ uuid: "other-draft", status: 10 }, { uuid: "another-draft", status: 10 }] : []);
  const first = await call("list_productions", { status: 3, limit: 2, offset: 4 });
  assert.deepEqual(first.items.map(({ uuid }) => uuid), ["done"]);
  assert.equal(first.next_offset, 6);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/productions.json");
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { limit: "2", offset: "4", minimal_data: "1" });
  const second = await call("list_productions", { status: 3, limit: 2, offset: first.next_offset });
  assert.deepEqual(second, { items: [], next_offset: 8 });
  assert.deepEqual(await call("list_productions", { offset: second.next_offset }), { items: [], next_offset: null });
});

test("list_productions omits unloaded fields; check_status shows actual absent and configured values", async (t) => {
  const draft = { uuid: "draft", status: 10, is_multitrack: true };
  const calls = mockAuphonic(t, ({ url }) => {
    if (url.pathname === "/api/productions.json") return [{ ...draft, output_files: [] }, { uuid: "empty", status: 10 }];
    if (url.pathname === "/api/production/empty.json") return { uuid: "empty", multi_input_files: [], speech_recognition: {} };
    return { ...draft, multi_input_files: [{ id: "host" }, { id: "guest" }], speech_recognition: { type: "whisper", language: "fr" } };
  });
  const { items: [listed, empty] } = await call("list_productions");
  for (const field of ["tracks", "speech_recognition", "destinations"]) assert.ok(!Object.hasOwn(listed, field), field);
  assert.deepEqual(listed.outputs, []);
  assert.ok(!Object.hasOwn(empty, "outputs"));
  assert.equal(calls.length, 1);
  const configured = await call("check_status", { production_uuid: "draft" });
  assert.deepEqual(configured.tracks.map(({ id }) => id), ["host", "guest"]);
  assert.deepEqual(configured.speech_recognition, { type: "whisper", language: "fr" });
  const absent = await call("check_status", { production_uuid: "empty" });
  assert.deepEqual(absent.tracks, []);
  assert.equal(absent.speech_recognition, null);
});

for (const [is_multitrack, requested, payload, effective, current = { levelermode: "default" }] of [
  [true, { levelermode: "standard" }, { leveler: true }, "default"],
  [false, { levelermode: "standard", levelerstrength: 80 }, { leveler: true, levelerstrength: 80 }, "default"],
  [true, { levelermode: "broadcast", maxlra: 8 }, { leveler: true, maxlra: 8, maxs: 0, maxm: 0 }, "broadcast"],
  [false, { levelermode: "musicspeech" }, { leveler: true, levelerstrength_speech: 100 }, "musicspeech"],
  [false, { levelermode: "musicspeech" }, { leveler: true }, "musicspeech", { levelermode: "musicspeech", levelerstrength_speech: 60 }],
]) {
  test(`update_production translates ${requested.levelermode} for ${is_multitrack ? "multitrack" : "singletrack"} and checks readback`, async (t) => {
    const draft = { uuid: "draft", status: 10, is_multitrack, algorithms: { ...current, loudnesstarget: -16 } };
    let updated = false;
    const calls = mockAuphonic(t, ({ method }) => {
      if (method === "POST") {
        updated = true;
        return draft; // The POST response does not confirm the change.
      }
      return updated ? { ...draft, algorithms: { ...draft.algorithms, ...payload, levelermode: effective } } : draft;
    });
    const result = await call("update_production", { production_uuid: "draft", algorithms: requested });
    assert.deepEqual(calls.map(({ method, url, body }) => [method, url.pathname, body]), [
      ["GET", "/api/production/draft.json", undefined],
      ["POST", "/api/production/draft/algorithms.json", payload],
      ["GET", "/api/production/draft.json", undefined],
    ]);
    assert.equal(result.algorithms.levelermode, effective);
    assert.equal(result.algorithms.loudnesstarget, -16);
    if (current.levelerstrength_speech !== undefined) assert.equal(result.algorithms.levelerstrength_speech, current.levelerstrength_speech);
  });
}

test("update_production does not partially update a Broadcast draft when asked to switch to Standard", async (t) => {
  const calls = mockAuphonic(t, () => ({ uuid: "draft", status: 10, is_multitrack: true, algorithms: { levelermode: "broadcast" } }));
  const result = await call("update_production", {
    production_uuid: "draft", title: "New title", algorithms: { levelermode: "standard", loudnesstarget: -18 },
  }, "LEVELER_MODE_UNSUPPORTED");
  assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
  assert.equal(result.next_action, "check_status");
});

test("update_production checks the saved mode even after a successful write", async (t) => {
  mockAuphonic(t, () => ({ uuid: "draft", status: 10, is_multitrack: true, algorithms: { levelermode: "default" } }));
  const result = await call("update_production", { production_uuid: "draft", algorithms: { levelermode: "broadcast" } }, "PRODUCTION_UPDATE_UNCONFIRMED");
  assert.deepEqual(result.unconfirmed_fields, ["algorithms.levelermode"]);
  assert.equal(result.production.algorithms.levelermode, "default");
});
