const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const childProcess = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dgram = require("node:dgram");
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const http2 = require("node:http2");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");
const { fileURLToPath } = require("node:url");

const activeMarker = process.env.SHOPIFY_E2E_SIDE_EFFECT_GUARD_ACTIVE_MARKER;
if (!activeMarker)
	throw new Error("doctor side-effect guard marker is required");
fs.writeFileSync(activeMarker, "active\n");

const allowedPaths = new Set(
	JSON.parse(process.env.SHOPIFY_E2E_WRITE_ALLOWLIST || "[]").map((path) =>
		resolve(path),
	),
);

const normalizePath = (value) => {
	if (value instanceof URL) return resolve(fileURLToPath(value));
	if (Buffer.isBuffer(value)) return resolve(value.toString());
	return typeof value === "string" ? resolve(value) : undefined;
};

const isAllowedWrite = (value) => {
	const path = normalizePath(value);
	return path !== undefined && allowedPaths.has(path);
};

const deny = (operation) => {
	throw new Error(
		`doctor test blocked package-owned side effect: ${operation}`,
	);
};

const guardPathWrite = (target, name) => {
	const original = target[name];
	target[name] = function (path, ...args) {
		if (!isAllowedWrite(path)) deny(name);
		return Reflect.apply(original, this, [path, ...args]);
	};
};

const denyOperation = (target, name) => {
	target[name] = () => {
		deny(name);
	};
};

for (const name of [
	"appendFile",
	"appendFileSync",
	"writeFile",
	"writeFileSync",
])
	guardPathWrite(fs, name);
for (const name of ["appendFile", "writeFile"])
	guardPathWrite(fsPromises, name);
guardPathWrite(fs, "createWriteStream");

for (const name of [
	"chmod",
	"chmodSync",
	"chown",
	"chownSync",
	"copyFile",
	"copyFileSync",
	"cp",
	"cpSync",
	"fchmod",
	"fchmodSync",
	"fchown",
	"fchownSync",
	"fdatasync",
	"fdatasyncSync",
	"fsync",
	"fsyncSync",
	"ftruncate",
	"ftruncateSync",
	"lchmod",
	"lchown",
	"lchownSync",
	"link",
	"linkSync",
	"lutimes",
	"lutimesSync",
	"mkdir",
	"mkdirSync",
	"mkdtemp",
	"mkdtempSync",
	"rename",
	"renameSync",
	"rm",
	"rmSync",
	"rmdir",
	"rmdirSync",
	"symlink",
	"symlinkSync",
	"truncate",
	"truncateSync",
	"unlink",
	"unlinkSync",
	"utimes",
	"utimesSync",
	"write",
	"writeSync",
	"writev",
	"writevSync",
])
	denyOperation(fs, name);

for (const name of [
	"chmod",
	"chown",
	"copyFile",
	"cp",
	"lchmod",
	"lchown",
	"link",
	"lutimes",
	"mkdir",
	"mkdtemp",
	"rename",
	"rm",
	"rmdir",
	"symlink",
	"truncate",
	"unlink",
	"utimes",
])
	denyOperation(fsPromises, name);

const writeMask =
	fs.constants.O_WRONLY |
	fs.constants.O_RDWR |
	fs.constants.O_APPEND |
	fs.constants.O_CREAT |
	fs.constants.O_TRUNC;
const requestsWriteAccess = (flags) =>
	typeof flags === "number"
		? (flags & writeMask) !== 0
		: /[+awx]/.test(String(flags));

for (const [target, name] of [
	[fs, "open"],
	[fs, "openSync"],
	[fsPromises, "open"],
]) {
	const original = target[name];
	target[name] = function (path, flags, ...args) {
		if (requestsWriteAccess(flags) && !isAllowedWrite(path)) deny(name);
		return Reflect.apply(original, this, [path, flags, ...args]);
	};
}

for (const [target, names] of [
	[
		childProcess,
		[
			"exec",
			"execFile",
			"execFileSync",
			"execSync",
			"fork",
			"spawn",
			"spawnSync",
		],
	],
	[http, ["get", "request"]],
	[https, ["get", "request"]],
	[net, ["connect", "createConnection"]],
	[net.Socket.prototype, ["connect"]],
	[tls, ["connect"]],
	[dgram, ["createSocket"]],
	[http2, ["connect"]],
	[dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]],
	[dnsPromises, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]],
]) {
	for (const name of names) denyOperation(target, name);
}

globalThis.fetch = () => deny("fetch");
if ("WebSocket" in globalThis) {
	globalThis.WebSocket = () => {
		deny("WebSocket");
	};
}
syncBuiltinESMExports();
