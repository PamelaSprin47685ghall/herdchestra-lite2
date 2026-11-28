import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	EXCLUSIVE,
	abortedError,
	isWriteTool,
	serializeWrite,
	targetKeys,
} from "../host-omp/src/host/write-serialization.mjs";

function scratch() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "herd-write-"));
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// A read-modify-write is the shape that loses updates: both calls read the old
// bytes, and the later write erases the earlier one.
function appendAfter(pathname, text, wait) {
	return async () => {
		const before = fs.readFileSync(pathname, "utf8");
		if (wait) await delay(wait);
		fs.writeFileSync(pathname, before + text);
	};
}

test("two concurrent writes to one file both survive", async () => {
	const dir = scratch();
	const file = path.join(dir, "one.txt");
	fs.writeFileSync(file, "");

	await Promise.all([
		serializeWrite("write", { path: file }, dir, appendAfter(file, "first\n", 30), null),
		serializeWrite("write", { path: file }, dir, appendAfter(file, "second\n", 0), null),
	]);

	assert.equal(fs.readFileSync(file, "utf8"), "first\nsecond\n");
});

test("writes to different files do not wait for each other", async () => {
	const dir = scratch();
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	fs.writeFileSync(first, "");
	fs.writeFileSync(second, "");

	const events = [];
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const held = serializeWrite("write", { path: first }, dir, async () => {
		events.push("a:start");
		await gate;
		events.push("a:end");
	}, null);

	await serializeWrite("write", { path: second }, dir, async () => {
		events.push("b");
	}, null);
	assert.deepEqual(events, ["a:start", "b"]);

	release();
	await held;
	assert.deepEqual(events, ["a:start", "b", "a:end"]);
});

test("a write whose targets cannot be named holds the whole queue", async () => {
	const dir = scratch();
	const file = path.join(dir, "c.txt");
	fs.writeFileSync(file, "");

	const events = [];
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const held = serializeWrite("write", { path: file }, dir, async () => {
		events.push("plain:start");
		await gate;
		events.push("plain:end");
	}, null);

	// `garbage` names no patch target, so the call must not guess a lock.
	const exclusive = serializeWrite("edit", { input: "garbage" }, dir, async () => {
		events.push("exclusive");
	}, null);

	await delay(25);
	assert.deepEqual(events, ["plain:start"]);

	release();
	await Promise.all([held, exclusive]);
	assert.deepEqual(events, ["plain:start", "plain:end", "exclusive"]);
});

test("a queued write drops out when its signal aborts", async () => {
	const dir = scratch();
	const file = path.join(dir, "d.txt");
	fs.writeFileSync(file, "");

	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const events = [];
	const held = serializeWrite("write", { path: file }, dir, async () => {
		await gate;
	}, null);

	const controller = new AbortController();
	const aborted = serializeWrite("write", { path: file }, dir, async () => {
		events.push("aborted-ran");
	}, controller.signal);
	controller.abort();

	// Bun's DOMException extends Error, so abortedError() returns signal.reason.
	await assert.rejects(aborted, (error) => error.name === "AbortError");
	release();
	await held;
	assert.deepEqual(events, []);
});

test("footprint classification never under-locks", () => {
	assert.equal(isWriteTool("edit"), true);
	assert.equal(isWriteTool("write"), true);
	assert.equal(isWriteTool("read"), false);
	assert.equal(EXCLUSIVE, "*");

	const dir = scratch();
	const named = targetKeys("write", { path: path.join(dir, "x.txt") }, dir);
	assert.deepEqual(named, { exclusive: false, keys: [path.join(fs.realpathSync(dir), "x.txt")] });

	for (const args of [{}, { path: "" }, { input: "not a patch" }, { paths: ["*"] }]) {
		const name = "paths" in args ? "ast_edit" : "edit";
		assert.deepEqual(targetKeys(name, args, dir), { exclusive: true, keys: [] });
	}

	assert.equal(abortedError({ reason: new Error("stop") }).message, "stop");
});
