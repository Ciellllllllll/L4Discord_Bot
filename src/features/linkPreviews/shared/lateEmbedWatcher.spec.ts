import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LateEmbedWatcher } from "./lateEmbedWatcher.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeMessage(id: string, options: { failSuppress?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    message: {
      id,
      suppressEmbeds: async () => {
        calls.push("suppress");
        if (options.failSuppress) throw new Error("Missing Permissions");
      },
    },
  };
}

// 監視中のメッセージに Discord が遅れて Embed を付けたら（messageUpdate）、すぐに抑制する
{
  const events = new EventEmitter();
  const warnings: unknown[] = [];
  const watcher = new LateEmbedWatcher(events, { warn: (obj) => { warnings.push(obj); } }, 1_000);
  const target = fakeMessage("m1");
  watcher.watch(target.message);
  assert.equal(events.listenerCount("messageUpdate"), 1);

  events.emit("messageUpdate", {}, { id: "other", embeds: [{}] });
  events.emit("messageUpdate", {}, { id: "m1", embeds: [] });
  await tick();
  assert.deepEqual(target.calls, [], "別のメッセージや Embed の無い更新（抑制による更新など）では何もしない");

  events.emit("messageUpdate", {}, { id: "m1", embeds: [{ url: "https://example.com" }] });
  await tick();
  assert.deepEqual(target.calls, ["suppress"]);

  // 複数のリンクの Embed が別々に付くこともあるので、監視期間中は何度でも抑制する
  events.emit("messageUpdate", {}, { id: "m1", embeds: [{ url: "https://example.org" }] });
  await tick();
  assert.deepEqual(target.calls, ["suppress", "suppress"]);
  assert.deepEqual(warnings, []);
  watcher.unwatch("m1");
  assert.equal(events.listenerCount("messageUpdate"), 0, "監視するメッセージが無くなったらリスナーを外す");
}

// 複数のメッセージを監視しても messageUpdate のリスナーは1本だけ
{
  const events = new EventEmitter();
  const watcher = new LateEmbedWatcher(events, { warn: () => undefined }, 1_000);
  const a = fakeMessage("a");
  const b = fakeMessage("b");
  watcher.watch(a.message);
  watcher.watch(b.message);
  watcher.watch(a.message);
  assert.equal(events.listenerCount("messageUpdate"), 1);
  events.emit("messageUpdate", {}, { id: "b", embeds: [{}] });
  await tick();
  assert.deepEqual([a.calls, b.calls], [[], ["suppress"]]);
  watcher.unwatch("a");
  assert.equal(events.listenerCount("messageUpdate"), 1);
  watcher.unwatch("b");
  assert.equal(events.listenerCount("messageUpdate"), 0);
}

// 監視期間が過ぎたら監視をやめ、リスナーも外す
{
  const events = new EventEmitter();
  const watcher = new LateEmbedWatcher(events, { warn: () => undefined }, 20);
  const target = fakeMessage("m1");
  watcher.watch(target.message);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(events.listenerCount("messageUpdate"), 0);
  events.emit("messageUpdate", {}, { id: "m1", embeds: [{}] });
  await tick();
  assert.deepEqual(target.calls, []);
}

// 抑制に失敗しても例外にせず、警告ログを残す
{
  const events = new EventEmitter();
  const warnings: unknown[] = [];
  const watcher = new LateEmbedWatcher(events, { warn: (obj) => { warnings.push(obj); } }, 1_000);
  const target = fakeMessage("m1", { failSuppress: true });
  watcher.watch(target.message);
  events.emit("messageUpdate", {}, { id: "m1", embeds: [{}] });
  await tick();
  assert.equal(warnings.length, 1);
  watcher.unwatch("m1");
}
